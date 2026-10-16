#ifndef __TASK_WEBSERVER_H__
#define __TASK_WEBSERVER_H__
 
#include <ESPAsyncWebServer.h>
#include "LittleFS.h"
#include <AsyncTCP.h>
#include <ArduinoJson.h>
#include <ElegantOTA.h>
#include "web/message_handler.h"
#include "app/shared_context.h"
 
extern AsyncWebServer server;
extern AsyncWebSocket ws;
extern String global_pump_state;   
extern String global_pump_mode;    
 
void Webserver_init_ctx(SharedContext* ctx);
void Webserver_stop();
void Webserver_reconnect();
void Webserver_sendata(String data);
 
#endif
