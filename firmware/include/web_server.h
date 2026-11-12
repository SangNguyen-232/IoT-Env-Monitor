#pragma once

#include <Arduino.h>

extern String global_fan_state;
extern String global_fan_mode;
struct SharedContext;
void Webserver_init_context(SharedContext *ctx);

void Webserver_stop();
void Webserver_reconnect();
void Webserver_sendata(String data);
