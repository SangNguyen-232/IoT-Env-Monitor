#pragma once

#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "ml_result.h"

struct SharedContext {
    float temperature;
    float humidity;
    bool dhtSampleValid;
    uint32_t dhtSampledAtMs;
    uint32_t sampleSeq = 0;
    char bootId[33] = {};
    // Independent soil telemetry; FAN and air-risk rules use DHT20 only.
    int soilMoisture;
    bool soilSampleValid;
    uint32_t soilSampledAtMs;
    SemaphoreHandle_t mutexContext;
    SemaphoreHandle_t semLEDUpdate;
    int ledState;
    SemaphoreHandle_t semNeoUpdate;
    int neoState;
    int lcdState;
    SemaphoreHandle_t semDBUpdate;
    time_t timestampReal;
    suseconds_t timestampRealUs;
    MlResult ml;
};

// Read and write under SharedContext::mutexContext.
extern volatile bool g_fanEventPending;
extern volatile bool g_aiEventPending;

extern String wifi_ssid;
extern String wifi_pass;

extern volatile bool g_wifiSwitchFlag;
extern SemaphoreHandle_t g_wifiSwitchMutex;
extern String g_wifiSwitchSSID;
extern String g_wifiSwitchPass;
