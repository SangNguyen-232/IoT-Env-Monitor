#include "tinyml.h"
#include "ai_telemetry.h"
#include "serial_log.h"
#include "web_server.h"
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "dht_fan_model.h"

namespace {
constexpr int kTensorArenaSize = 16 * 1024;
alignas(16) uint8_t tensor_arena[kTensorArenaSize];
tflite::MicroInterpreter *interpreter = nullptr;
TfLiteTensor *input = nullptr;
TfLiteTensor *output = nullptr;

bool setupTinyML()
{
    static tflite::MicroErrorReporter reporter;
    const tflite::Model *model = tflite::GetModel(fan_model_tflite);
    if (model->version() != TFLITE_SCHEMA_VERSION) return false;
    static tflite::MicroMutableOpResolver<2> resolver;
    if (resolver.AddFullyConnected() != kTfLiteOk || resolver.AddSoftmax() != kTfLiteOk) return false;
    static tflite::MicroInterpreter instance(model, resolver, tensor_arena, kTensorArenaSize, &reporter);
    interpreter = &instance;
    if (interpreter->AllocateTensors() != kTfLiteOk) return false;
    input = interpreter->input(0);
    output = interpreter->output(0);
    return input && output && input->type == kTfLiteFloat32 && output->type == kTfLiteFloat32
        && input->dims->size == 2 && input->dims->data[0] == 1 && input->dims->data[1] == 2
        && output->dims->size == 2 && output->dims->data[0] == 1 && output->dims->data[1] == 3;
}
}

void tiny_ml_task(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    if (!ctx || !ctx->mutexContext) { vTaskDelete(nullptr); return; }
    const bool modelReady = setupTinyML();
    if (!modelReady) {
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        ctx->ml.status = AiStatus::ModelError;
        xSemaphoreGive(ctx->mutexContext);
        Serial.println("[AI] Model initialization failed; rule fallback remains available");
    }
    uint32_t lastSeq = 0, lastSampledAt = 0, evaluated = 0, agreed = 0;
    while (true) {
        float t = 0, h = 0;
        bool valid = false;
        uint32_t seq = 0, sampledAt = 0;
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
            t = ctx->temperature; h = ctx->humidity;
            valid = ctx->dhtSampleValid;
            seq = ctx->sampleSeq;
            sampledAt = ctx->dhtSampledAtMs;
            xSemaphoreGive(ctx->mutexContext);
        }
        // At most one inference/count per sensor sample, independent of task phase.
        if (seq == 0 || (seq == lastSeq && sampledAt == lastSampledAt)) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        MlResult result;
        result.sampleSeq = seq;
        result.sampledAtMs = sampledAt;
        if (!modelReady) result.status = AiStatus::ModelError;
        else if (!dht_sample_is_fresh(valid, sampledAt, millis()) || !dht_sample_values_are_valid(t, h))
            result.status = AiStatus::SensorInvalid;
        else if (!fan_model_in_domain(t, h)) result.status = AiStatus::OutOfDomain;
        else {
            input->data.f[0] = t;
            input->data.f[1] = h;
            const uint32_t startedAt = micros();
            const TfLiteStatus invoked = interpreter->Invoke();
            result.inferenceMs = static_cast<uint32_t>(micros() - startedAt) / 1000.0f;
            result.status = AiStatus::InferenceError;
            if (invoked == kTfLiteOk) {
                int best = 0;
                for (int i = 0; i < 3; ++i) {
                    result.probabilities[i] = output->data.f[i];
                    if (output->data.f[i] > output->data.f[best]) best = i;
                }
                result.predicted = static_cast<FanAction>(best);
                result.rule = fan_model_teacher(t, h);
                if (ml_probabilities_valid(result)) result.status = AiStatus::Ready;
            }
        }
        bool published = false;
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
            if (ctx->sampleSeq == seq && ctx->dhtSampledAtMs == sampledAt) {
                if (result.status == AiStatus::Ready) {
                    if (evaluated == UINT32_MAX) { evaluated = 0; agreed = 0; }
                    ++evaluated;
                    if (result.predicted == result.rule) ++agreed;
                }
                result.evaluated = evaluated;
                result.agreed = agreed;
                ctx->ml = result;
                g_aiEventPending = true;
                published = true;
                lastSeq = seq; lastSampledAt = sampledAt;
            }
            xSemaphoreGive(ctx->mutexContext);
        }
        if (published) {
            xSemaphoreGive(ctx->semDBUpdate);
            JsonDocument doc;
            if (ai_snapshot_to_json(ctx, doc)) {
                String json;
                serializeJson(doc, json);
                Webserver_sendata(json);
            }
            serialLogLock();
            Serial.printf("[AI] sample=%lu status=%s teacher=%s proposal=%s p=[%.3f,%.3f,%.3f] latency=%.3fms agreement=%lu/%lu\n",
                static_cast<unsigned long>(seq), ai_status_name(result.status),
                fan_action_name(result.rule) ? fan_action_name(result.rule) : "--",
                fan_action_name(result.predicted) ? fan_action_name(result.predicted) : "--",
                result.probabilities[0], result.probabilities[1], result.probabilities[2], result.inferenceMs,
                static_cast<unsigned long>(agreed), static_cast<unsigned long>(evaluated));
            serialLogUnlock();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
