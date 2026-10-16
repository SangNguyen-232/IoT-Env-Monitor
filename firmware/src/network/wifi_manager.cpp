#include "network/wifi_manager.h"
#include "config/secrets.h"
#include <DNSServer.h>
 
static DNSServer dnsServer;
static bool dns_running = false;
static const IPAddress AP_IP(192, 168, 4, 1);
static const IPAddress AP_NETMASK(255, 255, 255, 0);
 
void startAP()
{
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(AP_IP, AP_IP, AP_NETMASK);
    WiFi.softAP(String(SSID_AP), String(PASS_AP));
    Serial.print("Địa chỉ IP chế độ AP Mode: ");
    Serial.println(WiFi.softAPIP());
 
    dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer.start(53, "*", AP_IP);
    dns_running = true;
    Serial.println("Captive Portal: DNS Server đã kích hoạt trên cổng 53");
}
 
void DNS_process()
{
    if (dns_running)
    {
        dnsServer.processNextRequest();
    }
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
 
    if (dns_running)
    {
        dnsServer.stop();
        dns_running = false;
        Serial.println("Captive Portal: Đã dừng DNS Server sau khi vào STA");
    }
 
    Serial.print("Địa chỉ IP chế độ STA Mode: ");
    Serial.println(WiFi.localIP());
 
    Save_sta_ip_File(WiFi.localIP().toString());
 
    configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
 
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
