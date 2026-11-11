#pragma once

#include <Arduino.h>

extern String global_fan_state;
extern String global_fan_mode;

void Webserver_stop();
void Webserver_reconnect();
void Webserver_sendata(String data);
