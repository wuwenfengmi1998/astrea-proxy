#!/bin/bash

APP_NAME="astea-proxy"
APP_USER="astea-proxy"
APP_PATH="/opt/$APP_NAME"
SERVICE_FILE="/etc/systemd/system/$APP_NAME.service"
LOG_PATH="/var/log/$APP_NAME"

echo "正在安装 $APP_NAME..."

# 创建专用用户
if ! id "$APP_USER" &>/dev/null; then
    echo "创建系统用户 $APP_USER..."
    sudo useradd -r -s /usr/sbin/nologin "$APP_USER"
fi

# 编译应用
echo "编译应用..."
CGO_ENABLED=0 GOOS=linux go build -o "$APP_NAME" .

# 先停止服务
echo "停止旧服务..."
sudo systemctl stop "$APP_NAME" 2>/dev/null
sudo systemctl disable "$APP_NAME" 2>/dev/null

# 创建目录
echo "创建目录..."
sudo mkdir -p "$APP_PATH"
sudo mkdir -p "$LOG_PATH"

# 复制文件
echo "复制文件..."
sudo cp "$APP_NAME" "$APP_PATH/"
if [ ! -f "$APP_PATH/config.json" ]; then
    sudo cp config.json "$APP_PATH/" 2>/dev/null || echo "  (本地无 config.json，首次启动将自动生成)"
fi

# 创建服务文件
echo "创建服务文件..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Astea Proxy
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_PATH
ExecStart=$APP_PATH/$APP_NAME
Restart=always
RestartSec=5
StandardOutput=append:$LOG_PATH/access.log
StandardError=append:$LOG_PATH/error.log

[Install]
WantedBy=multi-user.target
EOF

# 设置权限
echo "设置权限..."
sudo chown -R "$APP_USER:$APP_USER" "$APP_PATH"
sudo chown -R "$APP_USER:$APP_USER" "$LOG_PATH"
sudo chmod 750 "$APP_PATH/$APP_NAME"

# 重载并启动
echo "启动服务..."
sudo systemctl daemon-reload
sudo systemctl enable "$APP_NAME"
sudo systemctl start "$APP_NAME"

echo "安装完成！"
echo "使用以下命令管理服务："
echo "  sudo systemctl status $APP_NAME"
echo "  sudo journalctl -u $APP_NAME -f"
