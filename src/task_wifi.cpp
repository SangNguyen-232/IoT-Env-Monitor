#include "task_wifi.h"
#include "secrets.h"

void startAP()
{
    WiFi.mode(WIFI_AP);
    WiFi.softAP(String(SSID_AP), String(PASS_AP));
    Serial.print("Địa chỉ IP chế độ AP Mode: ");
    Serial.println(WiFi.softAPIP());
}

bool startSTA()
{
    if (wifi_ssid.isEmpty())
    {
        Serial.println("STA: SSID trống, bỏ qua kết nối.");
        return false;
    }

    WiFi.mode(WIFI_STA);

    if (wifi_pass.isEmpty())
        WiFi.begin(wifi_ssid.c_str());
    else
        WiFi.begin(wifi_ssid.c_str(), wifi_pass.c_str());

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 10000)
    {
        vTaskDelay(100 / portTICK_PERIOD_MS);
    }

    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("STA: kết nối thất bại, giữ task loop.");
        return false;
    }

    Serial.print("Địa chỉ IP chế độ STA Mode: ");
    Serial.println(WiFi.localIP());

    Save_sta_ip_File(WiFi.localIP().toString());

    configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");

    xSemaphoreGive(xBinarySemaphoreInternet);
    return true;
}

bool Wifi_reconnect()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        return true;
    }

    static unsigned long lastAttemptMs = 0;
    const unsigned long now = millis();
    if (lastAttemptMs != 0 && (now - lastAttemptMs) < 15000)
    {
        return true;
    }
    lastAttemptMs = now;

    if (startSTA())
    {
        return true;
    }

    startAP();
    return false;
}

void Wifi_switch_to(const String& ssid, const String& pass) {
    const String prevSsid = wifi_ssid;
    const String prevPass = wifi_pass;

    Save_info_NoRestart(ssid, pass);
    WiFi.disconnect(true);
    vTaskDelay(pdMS_TO_TICKS(500));

    if (startSTA())
    {
        Save_wifi_to_list(ssid, pass);
        return;
    }

    Serial.println("Chuyển WiFi thất bại, khôi phục mạng trước đó.");
    Save_info_NoRestart(prevSsid, prevPass);
    if (!startSTA())
    {
        startAP();
    }
}
