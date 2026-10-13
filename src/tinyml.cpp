#include "tinyml.h"
#include "risk_label.h"
#include "serial_log.h"
#include "temp_humi_monitor.h"
 
#include <math.h>
#include "dht_anomaly_model.h" 
namespace
{
    tflite::ErrorReporter *error_reporter = nullptr;
    const tflite::Model *model = nullptr;
    tflite::MicroInterpreter *interpreter = nullptr;
    TfLiteTensor *input = nullptr;
    TfLiteTensor *output = nullptr;
    constexpr int kTensorArenaSize = 16 * 1024;
    uint8_t tensor_arena[kTensorArenaSize];
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
        for (int i = 1; i < n; ++i)
        {
            if (p[i] > p[best])
                best = i;
        }
        return best;
    }
} 
 
void setupTinyML()
{
    s_tinyml_ready = false;
    static tflite::MicroErrorReporter micro_error_reporter;
    error_reporter = &micro_error_reporter;
 
    model = tflite::GetModel(dht_anomaly_model_tflite);
    if (model->version() != TFLITE_SCHEMA_VERSION)
    {
        error_reporter->Report("Model schema version %d != supported %d.",
                               model->version(), TFLITE_SCHEMA_VERSION);
        return;
    }
 
    static tflite::AllOpsResolver resolver;
    static tflite::MicroInterpreter static_interpreter(
        model, resolver, tensor_arena, kTensorArenaSize, error_reporter);
    interpreter = &static_interpreter;
 
    if (interpreter->AllocateTensors() != kTfLiteOk)
    {
        error_reporter->Report("AllocateTensors() failed");
        return;
    }
 
    input = interpreter->input(0);
    output = interpreter->output(0);
 
    if (!input || !output || input->type != kTfLiteFloat32 || output->type != kTfLiteFloat32)
    {
        error_reporter->Report("TinyML: expected float32 input/output");
        return;
    }
    if (tensor_element_count(input) != 3 || tensor_element_count(output) != 3)
    {
        error_reporter->Report("TinyML: need input 3 floats (temp,humi,soil), output 3 (softmax). Re-run ml/train_export.py");
        return;
    }
 
    s_tinyml_ready = true;
}
 
void tiny_ml_task(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    if (!ctx)
    {
        vTaskDelete(nullptr);
        return;
    }
 
    setupTinyML();
    if (!s_tinyml_ready)
    {
        vTaskDelete(nullptr);
        return;
    }
 
    unsigned long inferences = 0;
    unsigned long correct = 0;
 
    while (1)
    {
        float temperature = 0.0f;
        float humidity = 0.0f;
        float soil_moisture = 0.0f;
 
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(2000)) == pdTRUE)
        {
            temperature   = ctx->temperature;
            humidity      = ctx->humidity;
            soil_moisture = (float)ctx->soilMoisture;
            xSemaphoreGive(ctx->mutexContext);
        }
 
        if (isnan(temperature) || isnan(humidity) || temperature < 0.0f || humidity < 0.0f)
        {
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }
 
        input->data.f[0] = temperature;
        input->data.f[1] = humidity;
        input->data.f[2] = soil_moisture;
 
        const unsigned long t0 = millis();
        if (interpreter->Invoke() != kTfLiteOk)
        {
            error_reporter->Report("Invoke failed");
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }
        const unsigned long t1 = millis();
 
        const int nout = tensor_element_count(output);
        const int best = argmax_float(output->data.f, nout);
        const int predicted = best + 1; // Map index (0..2) -> Label (1..3)
 
        const int expected = risk_pure_mathematical_label(temperature, humidity, soil_moisture);
 
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE)
        {
            ctx->mlPredicted = predicted;
            ctx->mlConfidence = output->data.f[best];
            xSemaphoreGive(ctx->mutexContext);
        }
 
        if (predicted == expected)
            correct++;
        inferences++;
 
        // 1. Determine baseline status by comparing AI prediction and Math rule
        const char* status = "Mismatch"; 
        if (expected == predicted) {
            if (expected == 1) status = "Normal";
            else if (expected == 2) status = "Warning";
            else if (expected == 3) status = "Critical";
        }
 
        // 2. Check the condition to trigger ultimate emergency safety interlock
        bool is_safety_triggered = (temperature >= 40.0f || humidity >= 90.0f || soil_moisture < 15.0f || soil_moisture > 60.0f);
 
        // 3. Generate dynamic status string for Serial Log
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
 
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE)
        {
            strncpy(ctx->mlStatus, is_safety_triggered ? "Critical" : status, sizeof(ctx->mlStatus) - 1);
            ctx->mlStatus[sizeof(ctx->mlStatus) - 1] = '\0';
            // NOTE: roll_acc = % số lần model khớp với risk_pure_mathematical_label() (rule dùng để sinh nhãn train),
            // KHÔNG phải độ chính xác phát hiện bất thường trên dữ liệu thực.
            ctx->mlRollAcc = inferences ? (100.0f * (float)correct / (float)inferences) : 0.0f;
            xSemaphoreGive(ctx->mutexContext);
        }
 
        serialLogLock();
        Serial.printf("TinyML T=%.1f°C H=%.1f%% S=%02d%% | rule=%d pred=%d | %s | p=[%.2f,%.2f,%.2f] | %lums | roll_acc=%.1f%% (%lu/%lu)\n",
                      temperature, humidity, (int)soil_moisture, expected, predicted,
                      log_status_str,
                      output->data.f[0], output->data.f[1], output->data.f[2],
                      (unsigned long)(t1 - t0),
                      inferences ? (100.0f * (float)correct / (float)inferences) : 0.0f,
                      correct, inferences);
        serialLogUnlock();
 
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}