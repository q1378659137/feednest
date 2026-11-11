# FeedNest 1Panel 部署包

一个 zip，里面装好了镜像和安装脚本。**不需要联网拉取任何东西。**

```
feednest-1panel-v1.2.0/
├─ feednest-1.2.0.image.tar     ← ★ 镜像（约 245 MB，导入镜像就选它）
├─ 1panel-app/feednest/         ← 1Panel 本地应用（data.yml + compose + logo）
├─ load-image.sh                ← 导入镜像并校验
├─ install.sh / uninstall.sh    ← 命令行一键装 / 卸
├─ docker-compose.yml
├─ MANIFEST.txt
└─ README.md
```

> ⚠️ **这个 zip 本身不是镜像**，直接丢进 1Panel「导入镜像」会报
> `unrecognized image format`。必须先解压，再导入里面的 `feednest-1.2.0.image.tar`。

---

## 第 0 步：上传并解压

1Panel 面板 → **主机 → 文件**，把 `feednest-1panel-v1.2.0.zip` 上传到 `/opt`，右键**解压**。
或者用「主机 → 终端」：

```bash
cd /opt
unzip feednest-1panel-v1.2.0.zip
cd feednest-1panel-v1.2.0
ls -lh          # 应看到 feednest-1.2.0.image.tar（约 245MB）和几个 .sh
```

> 服务器没有 unzip 命令时：`apt install -y unzip`（或 `yum install -y unzip`）。

---

## 最快上手（两条命令）

```bash
cd /opt/feednest-1panel-v1.2.0
./load-image.sh        # 导入镜像 + 校验
./install.sh           # 启动，默认 13786
```

装完访问 `http://服务器IP:13786`，默认账号 **admin / admin**（登录后立刻改密码）。

---

## 方式一：1Panel 图形界面

### 1. 导入镜像

**容器 → 镜像 → 导入**，文件选择解压目录里的：

```
/opt/feednest-1panel-v1.2.0/feednest-1.2.0.image.tar
```

导入后回到「容器 → 镜像」刷新，列表里出现 `feednest:1.2.0` 就成功了。
**看不到就别往下做**，先看文末排查。

> 嫌界面上传慢或报错，直接用命令导入（会顺带校验）：
> ```bash
> cd /opt/feednest-1panel-v1.2.0 && ./load-image.sh
> ```

### 2. 放置本地应用

把解压目录里的 `1panel-app/feednest` 整个目录复制到 1Panel 的本地应用目录：

```bash
cp -r /opt/feednest-1panel-v1.2.0/1panel-app/feednest /opt/1panel/resource/apps/local/
```

> 1Panel 安装目录不是 `/opt/1panel` 的，先确认：`1pctl info | grep -i base`
> 目标路径是 `<安装目录>/resource/apps/local/`。

放好后结构必须是：

```
/opt/1panel/resource/apps/local/feednest/
├─ data.yml
├─ docker-compose.yml
├─ logo.png
└─ README.md
```

（不能多套一层 `1panel-app`）

### 3. 刷新应用列表并安装

1Panel → **应用商店** → 勾选右上角 **显示本地应用** → **更新应用列表** → 列表里出现 **FeedNest** → **安装**，设置端口（默认 `13786`）。

### 4. 打开使用

`http://服务器IP:13786`，`admin / admin` 登录。新部署是空的，点顶部「导入」选自己的 OPML 文件。

---

## 关于数据

- 1Panel 安装的应用：数据在 `/opt/1panel/apps/local/feednest/<实例名>/data`
- 命令行方式：数据在解压目录下的 `data/`
- 里面是 SQLite，**备份这个目录就等于备份全部订阅和已读状态**
- 新部署**没有任何预置订阅**

## 关于网络

镜像自带全部依赖，安装过程不需要外网。但**抓 RSS 需要服务器能访问目标站点**：

- 抓 GitHub 这类源，服务器需要能直连或有代理
- 有代理时编辑 `1panel-app/feednest/docker-compose.yml`（或命令行版的 `docker-compose.yml`），取消这两行注释：
  ```yaml
  - HTTPS_PROXY=http://192.168.1.10:7890
  - HTTP_PROXY=http://192.168.1.10:7890
  ```
  容器里的 `127.0.0.1` 指容器自己，代理要写宿主机**局域网 IP**

---

## 排查：镜像导入失败 / 导入后不显示

**`unrecognized image format`**
你选的是 zip，不是镜像。要选解压目录里的 `feednest-1.2.0.image.tar`。

**提示「导入成功」但镜像列表没有**
同上；或者选错了别的文件。用命令确认：
```bash
docker images | grep feednest
```
没输出 = 没导入成功。

**`docker load` 报 `no such file or directory`**
路径不对。`pwd` 看当前目录，或直接给绝对路径：
```bash
docker load -i /opt/feednest-1panel-v1.2.0/feednest-1.2.0.image.tar
```

**`exec format error`**
服务器是 ARM 架构（甲骨文 ARM、树莓派等），这个镜像只有 `linux/amd64`。
需要在 x86 机器上用源码重新构建：`docker build -t feednest:1.2.0 .`

---

## 其他常见问题

**应用商店里看不到 FeedNest**
目录层级不对（必须 `.../apps/local/feednest/data.yml`），或没勾「显示本地应用」/没点「更新应用列表」。

**端口被占用**
`./install.sh 8080` 换端口，或先停掉占用 13786 的容器。

**忘记密码**
登录后「设置 → 初始化设置」输入 `RESET`（清空所有订阅，管理员密码恢复 admin）。
只想重置密码不动数据：
```bash
docker exec -it feednest node --experimental-sqlite -e "
const {DatabaseSync}=require('node:sqlite');
new DatabaseSync('/data/feednest.db').exec(\"DELETE FROM users WHERE username='admin'\");
"
```
