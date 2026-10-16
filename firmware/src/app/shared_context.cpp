#include "app/shared_context.h"
 
volatile unsigned long g_lastDBPostMs_sensor = 0;
volatile unsigned long g_lastDBPostMs_pump = 0;
volatile bool g_pumpEventPending = false;
 
String wifi_ssid = "";
String wifi_pass = "";
 
volatile bool g_wifiSwitchFlag = false;
SemaphoreHandle_t g_wifiSwitchMutex = xSemaphoreCreateMutex();
String g_wifiSwitchSSID = "";
String g_wifiSwitchPass = "";
