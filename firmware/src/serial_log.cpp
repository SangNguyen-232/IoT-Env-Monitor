#include "serial_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static SemaphoreHandle_t s_serial_mtx;

void serialLogInit(void)
{
    if (s_serial_mtx == nullptr)
        s_serial_mtx = xSemaphoreCreateMutex();
}

void serialLogLock(void)
{
    if (s_serial_mtx != nullptr)
        xSemaphoreTake(s_serial_mtx, portMAX_DELAY);
}

void serialLogUnlock(void)
{
    if (s_serial_mtx != nullptr)
        xSemaphoreGive(s_serial_mtx);
}
