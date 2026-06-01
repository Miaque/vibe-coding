Import("env")

from pathlib import Path
import os


PROJECT_DIR = Path(env.subst("$PROJECT_DIR"))
ENV_FILE = PROJECT_DIR / ".env"
GENERATED_HEADER = PROJECT_DIR / "include" / "generated_config.h"

REQUIRED_KEYS = ("WIFI_SSID", "WIFI_PASSWORD", "MQTT_SERVER", "MQTT_TOPIC")
OPTIONAL_DEFAULTS = {
    "MQTT_PORT": "1883",
    "MQTT_USER": "",
    "MQTT_PASSWORD": "",
    "MQTT_CLIENT_ID": "esp32-s3-ssd1306",
}


def parse_env_file(path):
    values = {}

    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] == '"'
        ):
            value = unescape_double_quoted(value[1:-1])
        elif (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] == "'"
        ):
            value = value[1:-1]

        values[key] = value

    return values


def unescape_double_quoted(value):
    escapes = {
        "\\": "\\",
        '"': '"',
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }
    result = []
    i = 0

    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            i += 1
            result.append(escapes.get(value[i], value[i]))
        else:
            result.append(value[i])

        i += 1

    return "".join(result)


def macro_string(value):
    result = []

    for byte in value.encode("utf-8"):
        char = chr(byte)

        if char == "\\":
            result.append("\\\\")
        elif char == '"':
            result.append('\\"')
        elif char == "\n":
            result.append("\\n")
        elif char == "\r":
            result.append("\\r")
        elif char == "\t":
            result.append("\\t")
        elif 32 <= byte <= 126:
            result.append(char)
        else:
            result.append(f"\\{byte:03o}")

    return '"' + "".join(result) + '"'


file_values = parse_env_file(ENV_FILE)
settings = {
    key: os.environ.get(key, file_values.get(key, default))
    for key, default in OPTIONAL_DEFAULTS.items()
}

for key in REQUIRED_KEYS:
    settings[key] = os.environ.get(key, file_values.get(key, ""))

missing = [key for key in REQUIRED_KEYS if not settings[key]]

if missing:
    raise Exception(
        "Missing required firmware environment values: "
        + ", ".join(missing)
        + ". Create .env from .env.example or set them in the shell."
    )

try:
    mqtt_port = int(settings["MQTT_PORT"])
except ValueError as exc:
    raise Exception("MQTT_PORT must be an integer") from exc

GENERATED_HEADER.write_text(
    "\n".join(
        [
            "#pragma once",
            "",
            f"static const char WIFI_SSID_VALUE[] = {macro_string(settings['WIFI_SSID'])};",
            f"static const char WIFI_PASSWORD_VALUE[] = {macro_string(settings['WIFI_PASSWORD'])};",
            f"static const char MQTT_SERVER_VALUE[] = {macro_string(settings['MQTT_SERVER'])};",
            f"static const int MQTT_PORT_VALUE = {mqtt_port};",
            f"static const char MQTT_TOPIC_VALUE[] = {macro_string(settings['MQTT_TOPIC'])};",
            f"static const char MQTT_USER_VALUE[] = {macro_string(settings['MQTT_USER'])};",
            f"static const char MQTT_PASSWORD_VALUE[] = {macro_string(settings['MQTT_PASSWORD'])};",
            f"static const char MQTT_CLIENT_ID_VALUE[] = {macro_string(settings['MQTT_CLIENT_ID'])};",
            "",
        ]
    ),
    encoding="utf-8",
)
