#include "task_check_info.h"
#include "esp_log.h"
#include "secrets.h"

String g_sensorApiUrl;

void Load_info_File()
{
  if (!LittleFS.exists("/info.dat")) return;

  File file = LittleFS.open("/info.dat", "r");
  if (!file) return;

  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) return;

  wifi_ssid = doc["WIFI_SSID"].as<String>();
  wifi_pass = doc["WIFI_PASS"].as<String>();
}

void Delete_info_File()
{
  if (LittleFS.exists("/info.dat"))
  {
    LittleFS.remove("/info.dat");
  }
  if (LittleFS.exists("/wifi_list.json"))
  {
    LittleFS.remove("/wifi_list.json");
  }
  if (LittleFS.exists("/wifi_info.json"))
  {
    LittleFS.remove("/wifi_info.json");
  }

  Serial.println("Thiết bị đã được reset thành công.");
  Serial.flush();
  delay(100);
  ESP.restart();
}

void Save_info_File(String ssid, String pass)
{
  wifi_ssid = ssid;
  wifi_pass = pass;

  DynamicJsonDocument doc(512);
  doc["WIFI_SSID"] = ssid;
  doc["WIFI_PASS"] = pass;

  File configFile = LittleFS.open("/info.dat", "w");
  if (configFile)
  {
    serializeJson(doc, configFile);
    configFile.close();
  }
  ESP.restart();
}

bool check_info_File(bool check)
{
  if (!check)
  {
    if (!LittleFS.begin(true))
    {
      return false;
    }
    Load_info_File();
    Load_server_url();
  }

  if (wifi_ssid.isEmpty())
  {
    if (!check)
    {
      startAP();
    }
    return false;
  }
  return true;
}

void Save_sta_ip_File(String ip)
{
  if (!LittleFS.exists("/info.dat")) return;

  File file = LittleFS.open("/info.dat", "r");
  if (!file) return;

  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) return;

  doc["STA_IP"] = ip;

  File configFile = LittleFS.open("/info.dat", "w");
  if (configFile)
  {
    serializeJson(doc, configFile);
    configFile.close();
  }
}

void Load_wifi_list(DynamicJsonDocument &doc) {
    if (!LittleFS.exists("/wifi_list.json")) return;
    File file = LittleFS.open("/wifi_list.json", "r");
    if (!file) return;
    deserializeJson(doc, file);
    file.close();
}

bool Lookup_wifi_pass(const String &ssid, String &pass) {
    DynamicJsonDocument doc(1024);
    Load_wifi_list(doc);
    if (!doc.is<JsonArray>()) return false;
    for (JsonObject item : doc.as<JsonArray>()) {
        if (item["ssid"].as<String>() == ssid) {
            pass = item["pass"].as<String>();
            return true;
        }
    }
    return false;
}

void Save_wifi_to_list(String ssid, String pass) {
    DynamicJsonDocument doc(1024);
    Load_wifi_list(doc);

    if (!doc.is<JsonArray>()) {
        doc.clear();
        doc.to<JsonArray>();
    }
    JsonArray arr = doc.as<JsonArray>();

    // If the SSID already exists, update only the password and keep its current position
    for (JsonObject item : arr) {
        if (item["ssid"].as<String>() == ssid) {
            item["pass"] = pass;
            File f = LittleFS.open("/wifi_list.json", "w");
            if (f) { serializeJson(doc, f); f.close(); }
            return;
        }
    }

    // For a new SSID, prepend it to the beginning of the list (newest at the top, oldest at the bottom)
    DynamicJsonDocument newDoc(1024);
    JsonArray newArr = newDoc.to<JsonArray>();

    JsonObject newEntry = newArr.createNestedObject();
    newEntry["ssid"] = ssid;
    newEntry["pass"] = pass;

    for (JsonObject item : arr) {
        JsonObject copy = newArr.createNestedObject();
        copy["ssid"] = item["ssid"].as<String>();
        copy["pass"] = item["pass"].as<String>();
    }

    File f = LittleFS.open("/wifi_list.json", "w");
    if (f) { serializeJson(newDoc, f); f.close(); }
}

bool Load_first_wifi_from_list(String &ssid, String &pass) {
    DynamicJsonDocument doc(1024);
    Load_wifi_list(doc);
    if (!doc.is<JsonArray>() || doc.as<JsonArray>().size() == 0) return false;
    JsonObject first = doc.as<JsonArray>()[0];
    ssid = first["ssid"].as<String>();
    pass = first["pass"].as<String>();
    return !ssid.isEmpty();
}

void Load_server_url()
{
  g_sensorApiUrl = SENSOR_API_URL;
  if (!LittleFS.exists("/server.json")) return;
  File file = LittleFS.open("/server.json", "r");
  if (!file) return;
  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) return;
  String url = doc["url"].as<String>();
  url.trim();
  if (!url.isEmpty())
  {
    g_sensorApiUrl = url;
  }
}

void Save_server_url(const String& url)
{
  String trimmed = url;
  trimmed.trim();
  g_sensorApiUrl = trimmed;
  DynamicJsonDocument doc(512);
  doc["url"] = trimmed;
  File file = LittleFS.open("/server.json", "w");
  if (file)
  {
    serializeJson(doc, file);
    file.close();
  }
}

void Save_info_NoRestart(String ssid, String pass) {
    wifi_ssid = ssid;
    wifi_pass = pass;
    DynamicJsonDocument doc(512);
    doc["WIFI_SSID"] = ssid;
    doc["WIFI_PASS"] = pass;
    File configFile = LittleFS.open("/info.dat", "w");
    if (configFile) {
        serializeJson(doc, configFile);
        configFile.close();
    }
}