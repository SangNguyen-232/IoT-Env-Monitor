#pragma once

#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "fan_policy.h"

extern FanMode fan_requested_mode;
extern bool fan_manual_state;
extern const char *fan_last_reason;
extern uint32_t fan_decision_sample_seq;
extern uint32_t fan_decided_uptime_ms;
extern FanConfig fan_config;
extern FanConfig fan_decision_config;
extern SemaphoreHandle_t xMutexFanControl;

// Put the active-HIGH relay in its safe state before storage or networking starts.
void fan_init();
void task_fan(void *pvParameters);
