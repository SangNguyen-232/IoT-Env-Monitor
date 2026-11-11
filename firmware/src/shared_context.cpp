#include "shared_context.h"

volatile bool g_fanEventPending = false;

String wifi_ssid = "";
String wifi_pass = "";

volatile bool g_wifiSwitchFlag = false;
SemaphoreHandle_t g_wifiSwitchMutex = xSemaphoreCreateMutex();
String g_wifiSwitchSSID = "";
String g_wifiSwitchPass = "";
