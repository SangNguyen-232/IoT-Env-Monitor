#include "message_handler.h"
#include <ArduinoJson.h>
#include "device_config.h"
#include "web_server.h"

void handleWebSocketMessage(String message)
{
    JsonDocument doc;

    DeserializationError error = deserializeJson(doc, message);
    if (error) {
        return;
    }
    JsonObject value = doc["value"];
    // GPIO outputs are owned by their control tasks; never write arbitrary pins here.
    if (doc["page"] == "setting") {
        String WIFI_SSID = value["ssid"].as<String>();
        String WIFI_PASS = value["password"].as<String>();
        String SERVER_URL = value["server"].as<String>();

        if (WIFI_SSID.length() > 32 || WIFI_PASS.length() > 64 || SERVER_URL.length() > 256 ||
            (!SERVER_URL.isEmpty() && !(SERVER_URL.startsWith("http://") || SERVER_URL.startsWith("https://")))) return;

        if (!SERVER_URL.isEmpty()) {
            Save_server_url(SERVER_URL);
        }

        Webserver_sendata("{\"status\":\"OK\",\"page\":\"setting_saved\"}");

        if (!WIFI_SSID.isEmpty()) {
            Serial.println("SSID: " + WIFI_SSID);
            Save_wifi_to_list(WIFI_SSID, WIFI_PASS);
            Save_info_File(WIFI_SSID, WIFI_PASS);
        }
    }
}
