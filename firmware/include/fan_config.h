#pragma once

#include <ArduinoJson.h>
#include "fan_policy.h"

bool fan_config_from_json(JsonVariantConst json, FanConfig &config);
void fan_config_to_json(const FanConfig &config, JsonDocument &doc);
void fan_load_config();
bool fan_save_config(const FanConfig &config);
void fan_reset_config();
