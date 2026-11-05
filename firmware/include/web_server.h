#pragma once

#include <Arduino.h>
#include "shared_context.h"

extern String global_pump_state;
extern String global_pump_mode;

void Webserver_init_ctx(SharedContext *ctx);
void Webserver_stop();
void Webserver_reconnect();
void Webserver_sendata(String data);
