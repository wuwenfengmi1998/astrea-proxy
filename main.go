package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	TargetURL  string `json:"target_url"`
	ListenAddr string `json:"listen_addr"`
	SocketPath string `json:"socket_path"`
}

const configPath = "config.json"

func defaultConfig() Config {
	return Config{
		TargetURL:  "http://203.189.167.74",
		ListenAddr: ":8080",
		SocketPath: "",
	}
}

func loadConfig() Config {
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := defaultConfig()
			out, _ := json.MarshalIndent(cfg, "", "  ")
			if writeErr := os.WriteFile(configPath, out, 0644); writeErr != nil {
				log.Fatal("无法创建配置文件:", writeErr)
			}
			log.Printf("配置文件不存在，已创建默认配置: %s", configPath)
			return cfg
		}
		log.Fatal("读取配置文件失败:", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Fatal("解析配置文件失败:", err)
	}
	log.Printf("已加载配置文件: %s", configPath)
	return cfg
}

//go:embed polyfill.js
var polyfillJS []byte

//go:embed session_override.js
var sessionOverrideJS []byte

func main() {
	cfg := loadConfig()

	target, err := url.Parse(cfg.TargetURL)
	if err != nil {
		log.Fatal("Bad target URL:", err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	proxy.ModifyResponse = func(r *http.Response) error {
		ct := r.Header.Get("Content-Type")
		if !strings.Contains(ct, "text/html") {
			return nil
		}

		body, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			return err
		}

		html := string(body)

		// 1. 去掉废弃的 AppCache manifest
		html = strings.Replace(html, `manifest="cache.appcache"`, "", 1)

		// 2. 注入 polyfill + session override 脚本（带版本号防缓存）
		html = strings.Replace(html, "</head>",
			`<script src="/__polyfill.js?v=6"></script>`+"\n"+
			`<script src="/__session_override.js?v=1"></script>`+"\n"+
			`</head>`, 1)

		r.Body = io.NopCloser(strings.NewReader(html))
		r.ContentLength = int64(len(html))
		r.Header.Set("Content-Length", fmt.Sprintf("%d", len(html)))
		return nil
	}

	// 提供 polyfill.js
	http.HandleFunc("/__polyfill.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(polyfillJS)
	})

	// 提供 session_override.js
	http.HandleFunc("/__session_override.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(sessionOverrideJS)
	})

	// 拦截 cache.appcache 请求，返回空（避免浏览器报错）
	http.HandleFunc("/asteamobile/cache.appcache", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/cache-manifest")
		w.WriteHeader(http.StatusOK)
	})

	// 默认：走代理
	http.Handle("/", proxy)

	addr := cfg.ListenAddr
	hasTCP := addr != ""
	hasSocket := cfg.SocketPath != ""

	if !hasTCP && !hasSocket {
		log.Fatal("未配置任何监听方式：listen_addr 和 socket_path 均为空")
	}

	if hasTCP {
		log.Printf("TCP 监听: http://localhost%s", addr)
		go func() {
			if err := http.ListenAndServe(addr, nil); err != nil {
				log.Fatal(err)
			}
		}()
	}

	if hasSocket {
		os.Remove(cfg.SocketPath)
		ln, err := net.Listen("unix", cfg.SocketPath)
		if err != nil {
			log.Fatal("Unix socket 监听失败:", err)
		}
		log.Printf("Unix socket 监听: %s", cfg.SocketPath)
		if err := http.Serve(ln, nil); err != nil {
			log.Fatal(err)
		}
	}
}