# 数字馆藏保管交付

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查、OCFL 指定版本逻辑文件领取和收件查询。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

## 环境与运行

使用 Node.js 22.23.4。依赖通过 package-lock.json 锁定。准备环境时执行 `npm ci --ignore-scripts --no-audit --no-fund`，之后运行、构建、测试和演示均不下载资源。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址；服务绑定回环地址，来源网关与接收端在同一进程内使用独立端口。`DATA_DIR` 指定收件目录，默认 `./var`；`SCENARIO` 选择 fixtures/scenarios.json 中的来源场景。`npm run demo` 从临时空目录启动、实际领取来源字节、查询收件并退出，不回放旧日志。 `PORT` 可指定接收服务端口；未设置时仍自动选择空闲端口。

## 容器

```sh
docker build -t preservation-object-intake:local .
docker run --rm --network none preservation-object-intake:local npm test
docker run --rm --network none preservation-object-intake:local npm run demo
```

镜像构建准备阶段完成依赖安装，运行不需要公网服务。接口约定见 `docs/接入约定.md`，来源格式范围见 `docs/来源格式.md`。`src/source-metadata.mjs` 只识别文件元信息，不代表已提取结构化记录。文件收件与完整业务覆盖是不同状态。

## 结构化方式检查

结构化方式已开放：`POST /v1/intakes` 使用 `{"mode": "structured", "version": "v2"}`（version 缺省为清单 head）按 OCFL 清单领取指定版本的逻辑文件。领取前核对根清单与版本清单的 sidecar 摘要、根清单与版本清单的一致性以及每个内容的清单摘要；同一内容被多个逻辑路径或历史版本复用时只取一份字节，但逻辑关系全部保留在 records 与 evidence 中。缺内容、路径越出对象边界或清单不相符都会写入 issues 并反映为 partial 或 rejected，不会静默降级；历史里未被该版本引用的内容不在领取范围。日常 `npm test` 已覆盖真实收件、来源语义及持久查询；领域字段约定见接入文档，不以测试代替支持范围说明。
