#ifndef __TASK_WIFI_H__
#define __TASK_WIFI_H__
 
#include <WiFi.h>
#include "device_config.h"
#include "web_server.h"
 
extern bool Wifi_reconnect();
extern bool startSTA();
extern void startAP();
extern void DNS_process();
extern void Wifi_switch_to(const String& ssid, const String& pass);
 
#endif