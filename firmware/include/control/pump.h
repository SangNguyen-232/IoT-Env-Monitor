#ifndef __PUMP__
#define __PUMP__
 
#include "Wire.h"
#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
 
extern bool pump_manual_control;   
extern bool pump_manual_state;     
extern SemaphoreHandle_t xMutexPumpControl;
 
void task_pump(void *pvParameters);
 
#endif