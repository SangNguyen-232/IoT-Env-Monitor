#pragma once

#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "fan_policy.h"

extern bool fan_manual_control;
extern bool fan_manual_state;
extern FanConfig fan_config;
extern SemaphoreHandle_t xMutexFanControl;

// Put the active-HIGH relay in its safe state before storage or networking starts.
void fan_init();
void task_fan(void *pvParameters);
