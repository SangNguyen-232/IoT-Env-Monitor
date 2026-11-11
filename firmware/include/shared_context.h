#pragma once

#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

struct SharedContext {
    float temperature;
    float humidity;
    bool dhtSampleValid;
    uint32_t dhtSampledAtMs;
    // Independent soil telemetry; FAN and air-risk inference use DHT20 only.
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
    float mlRollAcc;
};

// Read and write under SharedContext::mutexContext.
extern volatile bool g_fanEventPending;

extern String wifi_ssid;
extern String wifi_pass;

extern volatile bool g_wifiSwitchFlag;
extern SemaphoreHandle_t g_wifiSwitchMutex;
extern String g_wifiSwitchSSID;
extern String g_wifiSwitchPass;
