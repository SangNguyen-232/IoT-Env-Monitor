#ifndef __TASK_WIFI_H__
#define __TASK_WIFI_H__
 
#include <WiFi.h>
#include "storage/device_config.h"
#include "web/web_server.h"
 
extern bool Wifi_reconnect();
extern bool startSTA();
extern void startAP();
extern void DNS_process();
extern void Wifi_switch_to(const String& ssid, const String& pass);
 
#endif