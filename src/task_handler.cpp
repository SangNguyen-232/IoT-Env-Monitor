#include <task_handler.h>

void handleWebSocketMessage(String message)
{
    StaticJsonDocument<256> doc;

    DeserializationError error = deserializeJson(doc, message);
    if (error)
    {
        return;
    }
    JsonObject value = doc["value"];
    if (doc["page"] == "device")
    {
        if (!value.containsKey("gpio") || !value.containsKey("status"))
        {
            return;
        }

        int gpio = value["gpio"];
        String status = value["status"].as<String>();
        pinMode(gpio, OUTPUT);
        if (status.equalsIgnoreCase("ON"))
        {
            digitalWrite(gpio, HIGH);
        }
        else if (status.equalsIgnoreCase("OFF"))
        {
            digitalWrite(gpio, LOW);
        }
    }
    else if (doc["page"] == "setting")
    {
        String WIFI_SSID = doc["value"]["ssid"].as<String>();
        String WIFI_PASS = doc["value"]["password"].as<String>();
        String SERVER_URL = doc["value"]["server"].as<String>();

        Serial.println("SSID: " + WIFI_SSID);

        if (!SERVER_URL.isEmpty())
        {
            Save_server_url(SERVER_URL);
        }

        String msg = "{\"status\":\"ok\",\"page\":\"setting_saved\"}";
        ws.textAll(msg);

        if (!WIFI_SSID.isEmpty())
        {
            Save_wifi_to_list(WIFI_SSID, WIFI_PASS);
            Save_info_File(WIFI_SSID, WIFI_PASS);
        }
    }
}