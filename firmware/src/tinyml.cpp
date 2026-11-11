#include "tinyml.h"
#include "risk_policy.h"
#include "input_safety.h"
#include "sensor_format.h"
#include "serial_log.h"
#include "shared_context.h"
#include <Arduino.h>
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include <math.h>
#include "dht_risk_model.h"

namespace
{
    tflite::ErrorReporter *error_reporter = nullptr;
    const tflite::Model *model = nullptr;
    tflite::MicroInterpreter *interpreter = nullptr;
    TfLiteTensor *input = nullptr;
    TfLiteTensor *output = nullptr;
    constexpr int kTensorArenaSize = 16 * 1024;
    alignas(16) uint8_t tensor_arena[kTensorArenaSize];
    bool s_tinyml_ready = false;

    int tensor_element_count(const TfLiteTensor *tensor)
    {
        int n = 1;
        for (int i = 0; i < tensor->dims->size; ++i)
            n *= tensor->dims->data[i];
        return n;
    }

    int argmax_float(const float *p, int n)
    {
        int best = 0;
        for (int i = 1; i < n; ++i) {
            if (p[i] > p[best])
                best = i;
        }
        return best;
    }

    void setupTinyML()
    {
        s_tinyml_ready = false;
        static tflite::MicroErrorReporter micro_error_reporter;
        error_reporter = &micro_error_reporter;

        model = tflite::GetModel(dht_anomaly_model_tflite);
        if (model->version() != TFLITE_SCHEMA_VERSION) {
            error_reporter->Report("Model schema version %d != supported %d.",
                                   model->version(), TFLITE_SCHEMA_VERSION);
            return;
        }

        static tflite::AllOpsResolver resolver;
        static tflite::MicroInterpreter static_interpreter(
            model, resolver, tensor_arena, kTensorArenaSize, error_reporter);
        interpreter = &static_interpreter;

        if (interpreter->AllocateTensors() != kTfLiteOk) {
            error_reporter->Report("AllocateTensors() failed");
            return;
        }

        input = interpreter->input(0);
        output = interpreter->output(0);

        if (!input || !output || input->type != kTfLiteFloat32 || output->type != kTfLiteFloat32) {
            error_reporter->Report("TinyML: expected float32 input/output");
            return;
        }
        if (tensor_element_count(input) != 2 || tensor_element_count(output) != 3) {
            error_reporter->Report("TinyML: need input 2 floats (temp,humi), output 3 (softmax). Re-run ml/train_export.py");
            return;
        }

        s_tinyml_ready = true;
    }
}

void tiny_ml_task(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    if (!ctx) {
        vTaskDelete(nullptr);
        return;
    }

    setupTinyML();
    if (!s_tinyml_ready) {
        vTaskDelete(nullptr);
        return;
    }

    unsigned long inferences = 0;
    unsigned long correct = 0;

    while (1) {
        float temperature = 0.0f;
        float humidity = 0.0f;
        bool sample_ready = false;

        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(2000)) == pdTRUE) {
            temperature   = ctx->temperature;
            humidity      = ctx->humidity;
            sample_ready  = dht_sample_is_fresh(ctx->dhtSampleValid, ctx->dhtSampledAtMs, millis());
            xSemaphoreGive(ctx->mutexContext);
        }

        if (!sample_ready || !dht_sample_values_are_valid(temperature, humidity)) {
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }

        input->data.f[0] = temperature;
        input->data.f[1] = humidity;

        const unsigned long t0 = millis();
        if (interpreter->Invoke() != kTfLiteOk) {
            error_reporter->Report("Invoke failed");
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }
        const unsigned long t1 = millis();

        const int nout = tensor_element_count(output);
        const int best = argmax_float(output->data.f, nout);
        const int predicted = best + 1; // Map index (0..2) -> Label (1..3)

        const int expected = risk_pure_mathematical_label(temperature, humidity);

        if (predicted == expected)
            correct++;
        inferences++;

        const char *status = "Mismatch";
        if (expected == predicted) {
            if (expected == 1) status = "Normal";
            else if (expected == 2) status = "Warning";
            else if (expected == 3) status = "Critical";
        }

        const bool is_safety_triggered = (temperature >= 40.0f || humidity >= 90.0f);

        char log_status_str[64];
        if (is_safety_triggered) {
            if (strcmp(status, "Critical") == 0) {
                snprintf(log_status_str, sizeof(log_status_str), "%s", status);
            } else {
                snprintf(log_status_str, sizeof(log_status_str), "%s -> Critical", status);
            }
        } else {
            snprintf(log_status_str, sizeof(log_status_str), "%s", status);
        }

        const float roll_acc = 100.0f * static_cast<float>(correct) / static_cast<float>(inferences);
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
            // roll_acc measures agreement between TFLite predictions and the mathematical training rule.
            ctx->mlRollAcc = roll_acc;
            xSemaphoreGive(ctx->mutexContext);
        }

        char temperature_text[8], humidity_text[8];
        sensor_format_temperature(temperature_text, sizeof(temperature_text), temperature);
        sensor_format_humidity(humidity_text, sizeof(humidity_text), humidity);
        serialLogLock();
        Serial.printf("TinyML T=%s°C H=%s%% | rule=%d pred=%d | %s | p=[%.2f,%.2f,%.2f] | %lums | roll_acc=%.1f%% (%lu/%lu)\n",
                      temperature_text, humidity_text, expected, predicted,
                      log_status_str,
                      output->data.f[0], output->data.f[1], output->data.f[2],
                      static_cast<unsigned long>(t1 - t0),
                      roll_acc,
                      correct, inferences);
        serialLogUnlock();

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
