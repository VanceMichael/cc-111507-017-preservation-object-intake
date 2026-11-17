# 数字馆藏保管交付

该服务用于保留已获授权的来源材料及其收件证据。当前提供原始资料接收、字节摘要、来源元信息检查和收件查询，并开放 OCFL 结构化收件：按指定版本清单把逻辑路径映射到真实内容后领取。来源服务和样例均在本机运行；资料中的单位、账号及标识都是合成值。

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

## 结构化 OCFL 收件

`POST /v1/intakes` 以 `{"mode":"structured","version":"v2"}` 发起，version 缺省为清单 head。服务先核对 NAMASTE 对象声明、根清单与版本清单的 sidecar 摘要及两份清单的一致性，再按所选版本 state 的 digest→逻辑路径与 manifest 的 digest→内容路径映射领取内容，并对下载字节重算摘要。每个指定版本的逻辑文件产生一条 record，共享同一内容的多条记录共用一个 SHA-256 blob；未被该版本 state 引用的历史内容不会领取。清单不可信为 rejected，来源缺内容为 partial，全部可靠取得才为 complete；缺内容、越界路径或清单不符都不会静默降级。`STRUCTURED=1 npm test` 仍可运行，结构化检查现已纳入默认测试集。
