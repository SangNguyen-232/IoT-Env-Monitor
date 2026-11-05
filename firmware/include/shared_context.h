#ifndef __GLOBAL_H__
#define __GLOBAL_H__
 
#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
 
struct SharedContext {
    float temperature;
    float humidity;
    int soilMoisture;
    int soilRaw;
    bool soilSampleValid;
    uint32_t soilSampledAtMs;
    SemaphoreHandle_t mutexContext;
    SemaphoreHandle_t semLEDUpdate;
    int ledState;
    SemaphoreHandle_t semNeoUpdate;
    int neoState;
    int lcdState;
    SemaphoreHandle_t semDBUpdate;
    int mlPredicted;
    float mlConfidence;
    time_t timestampReal;
    suseconds_t timestampRealUs;
    char mlStatus[16];
    float mlRollAcc;
    char dbTriggerSource[8];   // "sensor" | "pump"
};
 
extern volatile unsigned long g_lastDBPostMs_sensor;
extern volatile unsigned long g_lastDBPostMs_pump;
extern volatile bool g_pumpEventPending;
 
extern String wifi_ssid;
extern String wifi_pass;
 
extern volatile bool g_wifiSwitchFlag;
extern SemaphoreHandle_t g_wifiSwitchMutex;
extern String g_wifiSwitchSSID;
extern String g_wifiSwitchPass;
 
#endif
