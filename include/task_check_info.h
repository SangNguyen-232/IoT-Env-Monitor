#ifndef __TASK_CHECK_INFO_H__
#define __TASK_CHECK_INFO_H__

#include <ArduinoJson.h>
#include "LittleFS.h"
#include "global.h"
#include "task_wifi.h"

bool check_info_File(bool check);
void Load_info_File();
void Delete_info_File();
void Save_info_File(String ssid, String pass);
void Save_sta_ip_File(String ip);

void Load_wifi_list(DynamicJsonDocument &doc);
bool Lookup_wifi_pass(const String &ssid, String &pass);
void Save_wifi_to_list(String ssid, String pass);
bool Load_first_wifi_from_list(String &ssid, String &pass);
void Save_info_NoRestart(String ssid, String pass);

extern String g_sensorApiUrl;
void Load_server_url();
void Save_server_url(const String& url);

#endif