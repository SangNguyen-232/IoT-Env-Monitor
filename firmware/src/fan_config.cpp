#include "fan_config.h"
#include "fan.h"
#include <LittleFS.h>

static SemaphoreHandle_t configMutex = xSemaphoreCreateMutex();
static bool resetPending = false;
static const char *configPath = "/fan.json";
static const char *tempPath = "/fan.json.tmp";

bool fan_config_from_json(JsonVariantConst json, FanConfig &config)
{
    if (!json.is<JsonObjectConst>() ||
        !json["temperature_on"].is<float>() || !json["temperature_off"].is<float>() ||
        !json["humidity_on"].is<float>() || !json["humidity_off"].is<float>() ||
        !json["activation_logic"].is<const char *>()) return false;
    const char *logic = json["activation_logic"];
    if (strcmp(logic, "any") != 0 && strcmp(logic, "all") != 0) return false;
    config.temperatureOn = json["temperature_on"];
    config.temperatureOff = json["temperature_off"];
    config.humidityOn = json["humidity_on"];
    config.humidityOff = json["humidity_off"];
    config.requireBoth = strcmp(logic, "all") == 0;
    config.configured = true;
    return fan_config_is_valid(config);
}

void fan_config_to_json(const FanConfig &config, JsonDocument &doc)
{
    doc["configured"] = config.configured;
    doc["activation_logic"] = config.requireBoth ? "all" : "any";
    if (config.configured) {
        doc["temperature_on"] = config.temperatureOn;
        doc["temperature_off"] = config.temperatureOff;
        doc["humidity_on"] = config.humidityOn;
        doc["humidity_off"] = config.humidityOff;
    } else {
        doc["temperature_on"] = nullptr;
        doc["temperature_off"] = nullptr;
        doc["humidity_on"] = nullptr;
        doc["humidity_off"] = nullptr;
    }
}

static bool readConfig(const char *path, FanConfig &config)
{
    File file = LittleFS.open(path, "r");
    if (!file || file.size() == 0 || file.size() > 512) return false;
    JsonDocument doc;
    const auto error = deserializeJson(doc, file);
    file.close();
    return !error && fan_config_from_json(doc.as<JsonVariantConst>(), config);
}

void fan_load_config()
{
    FanConfig saved;
    // Missing or corrupt settings leave AUTO disabled; MANUAL remains available.
    if (xMutexFanControl == nullptr || !readConfig(configPath, saved)) return;
    if (xSemaphoreTake(xMutexFanControl, portMAX_DELAY) == pdTRUE) {
        fan_config = saved;
        xSemaphoreGive(xMutexFanControl);
    }
}

bool fan_save_config(const FanConfig &config)
{
    if (!config.configured || !fan_config_is_valid(config) ||
        configMutex == nullptr || xMutexFanControl == nullptr ||
        xSemaphoreTake(configMutex, pdMS_TO_TICKS(2000)) != pdTRUE) return false;
    if (resetPending) {
        xSemaphoreGive(configMutex);
        return false;
    }

    JsonDocument doc;
    fan_config_to_json(config, doc);
    File file = LittleFS.open(tempPath, "w");
    bool saved = false;
    if (file) {
        const size_t written = serializeJson(doc, file);
        file.flush();
        const bool writeOk = written == measureJson(doc) && file.getWriteError() == 0;
        file.close();
        FanConfig persisted;
        if (writeOk && readConfig(tempPath, persisted) && LittleFS.rename(tempPath, configPath)) {
            // The controller only holds this mutex for a short GPIO/state update.
            // Commit RAM after the complete, verified file has replaced the old one.
            xSemaphoreTake(xMutexFanControl, portMAX_DELAY);
            fan_config = persisted;
            xSemaphoreGive(xMutexFanControl);
            saved = true;
        }
    }
    if (!saved) LittleFS.remove(tempPath);
    xSemaphoreGive(configMutex);
    return saved;
}

void fan_reset_config()
{
    if (configMutex != nullptr) xSemaphoreTake(configMutex, portMAX_DELAY);
    // A pending HTTP save must not recreate settings during the reset delay.
    resetPending = true;
    LittleFS.remove(configPath);
    LittleFS.remove(tempPath);
    if (xMutexFanControl != nullptr) {
        xSemaphoreTake(xMutexFanControl, portMAX_DELAY);
        fan_config = FanConfig{};
        fan_manual_state = false;
        xSemaphoreGive(xMutexFanControl);
    }
    if (configMutex != nullptr) xSemaphoreGive(configMutex);
}
