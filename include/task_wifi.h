#ifndef __TASK_WIFI_H__
#define __TASK_WIFI_H__

#include <WiFi.h>
#include <task_check_info.h>
#include <task_webserver.h>

extern bool Wifi_reconnect();
extern bool startSTA();
extern void startAP();
extern void Wifi_switch_to(const String& ssid, const String& pass);

#endif