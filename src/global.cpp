#include "global.h"
 
float glob_temperature = 0;
float glob_humidity = 0;
float glob_soil = 0;
volatile unsigned long g_lastDBPostMs_sensor = 0;
volatile unsigned long g_lastDBPostMs_pump = 0;
volatile bool g_pumpEventPending = false;
 
String wifi_ssid = "";
String wifi_pass = "";
 
boolean isWifiConnected = false;
SemaphoreHandle_t xBinarySemaphoreInternet = xSemaphoreCreateBinary();
 
volatile bool g_wifiSwitchFlag = false;
String g_wifiSwitchSSID = "";
String g_wifiSwitchPass = "";