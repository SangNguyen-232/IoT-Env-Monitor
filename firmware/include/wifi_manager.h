#pragma once

#include <Arduino.h>

bool Wifi_reconnect();
bool startSTA();
void startAP();
void DNS_process();
void Wifi_switch_to(const String &ssid, const String &pass);
