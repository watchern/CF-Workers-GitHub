"use strict";

let blockedCrawlerUA = ["netcraft"];

// ---------------配置信息-------------
// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
const PREFIX = "/"; // 路由前缀
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
  jsdelivr: 1, // 配置是否使用jsDelivr镜像
  allowGit: 0, // 是否允许 git clone/fetch/push（0=拦截，1=放行）
  // 个人 git 密钥：拦截开启时凭此仍可 git 操作；推荐在 CF Dashboard 环境变量
  // GIT_KEYS 中设置（逗号分隔多个），本文件留空表示仅用环境变量。用法：
  //   git clone https://git:<密钥>@gh.llim.qzz.io/https://github.com/user/repo.git
  gitKeys: [],
};
// 获取当前访问的域名
let visit_host = "";
const PROXY_SITES = [
  "https://gh-proxy.org/",
  "https://v4.gh-proxy.org/",
  "https://v6.gh-proxy.org/",
  "https://cdn.gh-proxy.org/",
  "https://axisnow.gh-proxy.org/",
];
// 每次调用随机挑一个加速站：在 fetch 与 bodyReplace 内调用，实现每请求轮换，
// 而不是每个实例冷启动时定死一个
function pickProxySite() {
  return PROXY_SITES[Math.floor(Math.random() * PROXY_SITES.length)] || "";
}

// ---------------配置信息-------------

const whiteList = []; // 白名单，路径中包含白名单字符的请求才会通过，例如 ['/username/']

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
  status: 204, // 响应状态码
  headers: new Headers({
    "access-control-allow-origin": "*", // 允许所有来源
    "access-control-allow-methods":
      "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS", // 允许的HTTP方法
    "access-control-max-age": "1728000", // 预检请求的缓存时间
  }),
};

const RE_GITHUB_REPO = /^(?:https?:\/\/)?github\.com\/.+?\/.*$/i;
// 匹配 GitHub的项目地址，例如 https://github.com/watchern/CF-Workers-GitHub
const RE_GITHUB_BLOB_RAW = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i;
// 匹配 GitHub的blob或raw路径
const RE_GIT_INFO = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i;
// 匹配 GitHub的info或git-路径
const RE_RAW_FILE =
  /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;
// 匹配 raw.githubusercontent.com的路径
const RE_GIST_FILE =
  /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i;
// 匹配 Gist的路径
const RE_GITHUB_TAGS = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i;
// 匹配 GitHub的tags路径
const RE_GITHUB_COLLECTOR =
  /^(?:https?:\/\/)?collector\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;
// 匹配 collector.github.com的路径

/**
 * 创建响应对象
 * @param {any} body - 响应体
 * @param {number} status - 状态码
 * @param {Object<string, string>} headers - 响应头
 */
function makeRes(body, status = 200, headers = {}) {
  headers["access-control-allow-origin"] = "*"; // 设置跨域头
  return new Response(body, { status, headers }); // 返回新的响应
}

/**
 * 创建URL对象
 * @param {string} urlStr - URL字符串
 */
function parseUrl(urlStr) {
  try {
    return new URL(urlStr); // 尝试创建URL对象
  } catch (err) {
    return null; // 如果失败，返回null
  }
}

/**
 * 检查URL是否属于 GitHub 系域名（用于决定重定向是否改写、还是由 Worker 内部跟随）
 * @param {string} u - 待检查的URL
 */
function isGithubishUrl(u) {
  for (let i of [
    RE_GITHUB_REPO,
    RE_GITHUB_BLOB_RAW,
    RE_GIT_INFO,
    RE_RAW_FILE,
    RE_GIST_FILE,
    RE_GITHUB_TAGS,
    RE_GITHUB_COLLECTOR,
  ]) {
    if (u.search(i) === 0) {
      return true; // 如果匹配，返回true
    }
  }
  return false; // 如果不匹配，返回false
}

/**
 * 处理HTTP请求
 * @param {Request} req - 请求对象
 * @param {string} pathname - 请求路径
 */
function httpHandler(req, pathname) {
  const reqHdrRaw = req.headers;

  // 处理预检请求
  if (
    req.method === "OPTIONS" &&
    reqHdrRaw.has("access-control-request-headers")
  ) {
    return new Response(null, PREFLIGHT_INIT); // 返回预检响应
  }

  const reqHdrNew = new Headers(reqHdrRaw);

  // 修改Accept-Language请求头，将zh-CN替换为zh-SG
  if (reqHdrNew.has("accept-language")) {
    const acceptLanguage = reqHdrNew.get("accept-language");
    const modifiedAcceptLanguage = acceptLanguage.replace("zh-CN", "zh-SG");
    reqHdrNew.set("accept-language", modifiedAcceptLanguage);
  }

  let urlStr = pathname;
  let inWhitelist = !Boolean(whiteList.length); // 如果白名单为空，默认允许
  for (let i of whiteList) {
    if (urlStr.includes(i)) {
      inWhitelist = true; // 如果路径包含白名单中的任意项，允许请求
      break;
    }
  }
  if (!inWhitelist) {
    return new Response("blocked", { status: 403 }); // 不在白名单中，返回403
  }
  if (urlStr.search(/^https?:\/\//) !== 0) {
    urlStr = "https://" + urlStr; // 确保URL以https开头
  }
  const urlObj = parseUrl(urlStr);

  /** @type {RequestInit} */
  const reqInit = {
    method: req.method, // 请求方法
    headers: reqHdrNew, // 请求头
    redirect: "manual", // 手动处理重定向
    body: req.body, // 请求体
  };
  return proxy(urlObj, reqInit); // 代理请求
}

/**
 *
 * @param {URL} urlObj - 目标URL对象
 * @param {RequestInit} reqInit - 请求初始化对象
 */
async function proxy(urlObj, reqInit) {
  const res = await fetch(urlObj.href, reqInit); // 发送请求并获取响应
  const resHdrOld = res.headers;
  const resHdrNew = new Headers(resHdrOld);

  const status = res.status;

  if (resHdrNew.has("location")) {
    // 如果响应包含重定向
    let redirectTarget = resHdrNew.get("location");
    if (isGithubishUrl(redirectTarget))
      resHdrNew.set("location", PREFIX + redirectTarget); // 修改重定向URL
    else {
      reqInit.redirect = "follow"; // 允许自动跟随重定向
      return proxy(parseUrl(redirectTarget), reqInit); // 递归处理新的重定向
    }
  }
  resHdrNew.set("access-control-expose-headers", "*"); // 设置跨域暴露头
  resHdrNew.set("access-control-allow-origin", "*"); // 允许所有来源

  resHdrNew.delete("content-security-policy"); // 删除安全策略头
  resHdrNew.delete("content-security-policy-report-only"); // 删除报告模式的安全策略头
  resHdrNew.delete("clear-site-data"); // 删除清除站点数据的头

  // 替换响应体中的 GitHub 链接
  const contentType = resHdrNew.get("content-type") || "";
  let responseBody = res.body;
  if (/text\/html/i.test(contentType)) {
    const text = await res.text();
    responseBody = bodyReplace(text, `https://${visit_host}${PREFIX}`);
  }

  return new Response(responseBody, {
    status,
    headers: resHdrNew,
  }); // 返回新的响应
}

// 模块级常量：正则只编译一次、注入片段只构造一次，避免每次请求重复开销
const RE_HTML_DOCTYPE = /<!doctype\s+html/i; // 完整 HTML 文档判定（容忍大小写与空白）
const RE_SRC_GITHUB = /(\bsrc\s*=\s*)(["'])https:\/\/github\.com\//gi; // 兼容大小写与单/双引号
const RE_HEAD_END = /<\/head\s*>/i; // 容忍 </HEAD>、</head >
const RE_HREF_ARCHIVE =
  /(\bhref\s*=\s*)(["'])(?:https?:\/\/github\.com)?\/(?!\/)(?=[^"']*\/[^"']*\/archive\/refs\/)/gi; // 归档包链接：href="/user/repo/archive/refs/tags/..." 或 href="https://github.com/user/repo/archive/refs/tags/..."（要求 / 前有两段属主/仓库路径）
const RE_HREF_RELEASE =
  /(\bhref\s*=\s*)(["'])(?:https?:\/\/github\.com)?\/(?!\/)(?=[^"']*\/[^"']*\/releases\/download\/)/gi; // release 资产链接：href="/user/repo/releases/download/..."（含绝对形式，exe/deb/rpm/msi/dmg/AppImage 等任意发布包）
const RE_HREF_ROOTREL = /(\bhref\s*=\s*)(["'])\/(?!\/)/gi; // 根相对链接 href="/..."（排除协议相对 "//"）
const REWORD_SCRIPT =
  '<script src="https://cdn.jsdelivr.net/gh/watchern/reword@master/i.js" type="text/javascript"></script>';
// SPA 死链修正脚本：GitHub 是 SPA，局部刷新后新插入的链接会脱离镜像——
// ① 相对路径 img/a 解析到镜像站自身形成死链；
// ② 绝对 raw.githubusercontent.com / github.com 链接点击后直跳真实域名（国内无法访问）。
// MutationObserver 持续监听 + 定时兜底扫描，把两类都改写为经本镜像代理的绝对地址。
// 按请求构造（BASE 依赖当前访问域名），标记属性用于幂等判断
function buildSpaFixScript(base) {
  return (
    '<script ' +
    SPA_FIX_MARK +
    '>' +
    '(function(){' +
    'var BASE=' +
    JSON.stringify(base) +
    ';' +
    'function fix(el,attr){' +
    'var v=el.getAttribute(attr);' +
    'if(!v)return;' +
    'if(v.charCodeAt(0)===47){' +
    'if(v.charCodeAt(1)===47||v.slice(0,14)==="/_next/static/")return;' +
    'var f1=BASE+"https://github.com"+v;' +
    'if(v!==f1)el.setAttribute(attr,f1);' +
    'return;' +
    '}' +
    'if(v.slice(0,8)==="https://"||v.slice(0,7)==="http://"){' +
    'var rest=v.slice(v.indexOf("/")+2);' +
    'if(rest.slice(0,26)==="raw.githubusercontent.com/"||rest.slice(0,11)==="github.com/"){var f2=BASE+v;if(v!==f2)el.setAttribute(attr,f2);}' +
    'return;' +
    '}' +
    '}' +
    'function scan(root){' +
    'if(!root.querySelectorAll)return;' +
    'var i,imgs=root.querySelectorAll("img[src]");' +
    'for(i=0;i<imgs.length;i++)fix(imgs[i],"src");' +
    'var links=root.querySelectorAll("a[href]");' +
    'for(i=0;i<links.length;i++)fix(links[i],"href");' + '}' +
    'var mo=new MutationObserver(function(ms){' +
    'for(var k=0;k<ms.length;k++){' +
    'var m=ms[k],n,node;' +
    'for(n=0;n<m.addedNodes.length;n++){' +
    'node=m.addedNodes[n];' +
    'if(node.nodeType===1){' +
    'if(node.tagName==="IMG")fix(node,"src");' +
    'if(node.tagName==="A")fix(node,"href");' +
    'if(node.querySelectorAll)scan(node);' + '}' + '}' + '}' +
    '});' +
    'function start(){' +
    'mo.observe(document.documentElement,{childList:true,subtree:true});' +
    'scan(document);' +
    'setInterval(function(){scan(document);},1500);' +
    '}' +
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start);}' +
    'else{start();}' +
    '})();' +
    '</script>'
  );
}
const REWORD_MARK = "cdn.jsdelivr.net/gh/watchern/reword"; // 幂等判断标记
const SPA_FIX_MARK = "data-spa-link-fixer"; // SPA 死链修正脚本的幂等标记

/**
 * 改写上游 HTML：资源链接改走本代理，并在 </head> 前注入打赏脚本
 * @param {string} content 上游响应体（HTML 文本）
 * @param {string} base 本代理基址，形如 `https://${visit_host}${PREFIX}`
 * @returns {string}
 */
function bodyReplace(content, base) {
  const isFullDoc = RE_HTML_DOCTYPE.test(content);
  // GitHub 的 expanded_assets 等 HTML 片段不带 <!DOCTYPE html>，
  // 仅对包含 /releases/（资产列表）或 /archive/refs/（Source code 归档包，
  // 见无二进制资产的 release）的片段做链接补全；其余原样返回
  if (
    !isFullDoc &&
    !content.includes("/releases/") &&
    !content.includes("/archive/refs/")
  ) {
    return content;
  }

  if (isFullDoc) {
    //原始：src="https://github.com/user/repo/releases/download/v1.0/file.zip"
    //替换后：src="https://example.com/https://github.com/user/repo/releases/download/v1.0/file.zip"
    content = content.replace(
      RE_SRC_GITHUB,
      (_, attr, quote) => `${attr}${quote}${base}https://github.com/`,
    );

    // --- 引入打赏脚本（已注入则跳过，避免重复代理时叠加）----
    if (!content.includes(REWORD_MARK)) {
      content = content.replace(RE_HEAD_END, `${REWORD_SCRIPT}</head>`);
    }

    // --- 注入 SPA 死链修正脚本（服务端已改写的链接本来就是绝对地址，
    //     脚本只为 SPA 局部刷新后新插入的相对路径链接兜底）----
    if (!content.includes(SPA_FIX_MARK)) {
      content = content.replace(RE_HEAD_END, buildSpaFixScript(base) + "</head>");
    }
  }

  // 每次响应随机挑一个加速站，与 ？q= 跳转同为每请求轮换；
  // 归档链与 release 资产链共用同一次抽中的站，保证同页链接目标一致
  const proxySite = pickProxySite();

  // 归档包链接（release 页的 Source code (zip) / Source code (tar.gz)）
  //原始 href="/user/repo/archive/refs/tags/v1.24.1-pre.zip"
  // 原始 href="/user/repo/archive/refs/tags/v1.24.1-pre.tar.gz"
  // 替换后 href="https://proxy.com/https://github.com/user/repo/archive/refs/tags/v1.24.1-pre.zip"
  content = content.replace(
    RE_HREF_ARCHIVE,
    (_, attr, quote) => `${attr}${quote}${proxySite}https://github.com/`,
  );

  // release 资产链接（release 页的二进制发布包，exe/deb/rpm/msi/dmg/AppImage 等任意格式）
  //原始 href="/user/repo/releases/download/v1.24.1-pre/zedg-setup-windows-x86_64-v1.24.1-pre.exe"
  // 替换后 href="https://proxy.com/https://github.com/user/repo/releases/download/v1.24.1-pre/zedg-setup-windows-x86_64-v1.24.1-pre.exe"
  content = content.replace(
    RE_HREF_RELEASE,
    (_, attr, quote) => `${attr}${quote}${proxySite}https://github.com/`,
  );

  // 根相对链接（如 release 资产列表 expanded_assets 的 href="/user/repo/releases/download/..."）
  // 补全为经镜像代理的绝对地址，否则会解析到镜像站自身路径导致断链
  content = content.replace(
    RE_HREF_ROOTREL,
    (_, attr, quote) => `${attr}${quote}${base}https://github.com/`,
  );

  return content;
}

/**
 * 主要的请求处理函数
 * @param {Request} request - 原始请求对象
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const urlStr = request.url;
    const urlObj = new URL(urlStr);
    // 获取当前访问的域名
    visit_host = urlObj.host;

    if (env.UA)
      blockedCrawlerUA = blockedCrawlerUA.concat(await parseUaList(env.UA));
    const userAgentHeader = request.headers.get("User-Agent");
    const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
    if (
      blockedCrawlerUA.some(
        (blockedKeyword) => userAgent.includes(blockedKeyword),
      ) &&
      blockedCrawlerUA.length > 0
    ) {
      // 首页改成一个nginx伪装页
      return new Response(await nginx(), {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
        },
      });
    }
    let path = urlObj.searchParams.get("q");
    if (path) {
      path = path.replace('https://','')
      return Response.redirect("https://" + visit_host + PREFIX + path, 301); // 重定向到带前缀的路径
    } else if (url.pathname.toLowerCase() == "/favicon.ico") {
      let iconData = "";
      iconData =
        "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";
      // 将base64解码为二进制数据
      const binaryData = atob(iconData);
      const uint8Array = new Uint8Array(binaryData.length);
      for (let i = 0; i < binaryData.length; i++) {
        uint8Array[i] = binaryData.charCodeAt(i);
      }

      // 返回icon图像
      return new Response(uint8Array, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400", // 缓存一天
        },
      });
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href
      .substr(urlObj.origin.length + PREFIX.length)
      .replace(/^https?:\/+/, "https://");
    // 下载类直链交给第三方加速站；其余（如仓库页面）仍走本镜像自身
    // 📄 分支源码：github.com/user/project/archive/master.zip
    // 📁 release源码：github.com/user/project/archive/v0.1.0.tar.gz（或 /archive/refs/tags/...）
    // 📂 release文件：github.com/user/project/releases/download/v0.1.0/example.zip
    // 判定：
    //  - /releases/download/ 下的任意文件（exe/deb/rpm/msi/dmg/AppImage/apk 等发布包都走这里），
    //    该路径是 GitHub 保留的下载路由，下面只有文件、没有页面，无需按后缀区分；
    //  - /archive/ 只认 GitHub 自动生成的源码归档（zip/tar.gz/tgz/tar），
    //    并排除 /blob/ /tree/ 等页面路由，避免仓库里恰好有 archive 目录时误判
    const isProxyDownload =
      /\/releases\/download\/.+/i.test(path) ||
      (/\/archive\/.+$/i.test(path) &&
        !/\/(?:blob|tree|blame|commits?|wiki)\//i.test(path) &&
        /\.(?:zip|tar\.gz|tgz|tar)(?:[?#].*)?$/i.test(path));
    // git 协议拦截：git clone/fetch/push 的 HTTP 特征为 info/refs?service=git-*、
    // git-upload-pack、git-receive-pack 四个端点，或 User-Agent 含 git/；
    // Config.allowGit=1 时放行，默认拦截（无有效密钥返回 401 认证挑战，
    // git 客户端会提示输入密钥，避免 403 让人误以为密钥错误）
    const isGitOperation =
      (/\/info\/refs$/i.test(urlObj.pathname) &&
        /service=git-(?:upload|receive)-pack/i.test(urlObj.search)) ||
      /\/(?:git-upload-pack|git-receive-pack)\/?$/i.test(urlObj.pathname) ||
      (userAgent !== "null" &&
        /^git\/(?:1|2)\./.test(userAgent) &&
        !urlObj.searchParams.get("q"));
    // 个人密钥穿透：git clone https://user:pass@域名/... 时客户端从首个请求起
    // 会携带 HTTP Basic 认证头（内容即 clone URL 里的 user:token 凭据），
    // 用户名或密码命中密钥列表（内置 gitKeys 或环境变量 GIT_KEYS）即放行；
    // 放行后剥离该头再转发上游，否则 GitHub 会把它当无效 token 拒绝
    const ownerKeys = Config.gitKeys.concat(
      env.GIT_KEYS ? await parseUaList(env.GIT_KEYS) : [],
    );
    const basicAuth = request.headers.get("authorization") || "";
    let isOwnerGit = false;
    if (basicAuth.startsWith("Basic ") && ownerKeys.length > 0) {
      try {
        const decoded = atob(basicAuth.slice(6).trim());
        const sep = decoded.indexOf(":");
        isOwnerGit =
          ownerKeys.includes(sep === -1 ? decoded : decoded.slice(0, sep)) ||
          ownerKeys.includes(sep === -1 ? "" : decoded.slice(sep + 1));
      } catch (e) {}
    }
    if (isGitOperation && !Config.allowGit) {
      if (!isOwnerGit) {
        const hasCreds = basicAuth.startsWith("Basic ");
        // 匿名请求（含公共仓 clone）→ 403 纯文案，不弹凭据框，
        // 避免用户误以为钓鱼站在索要 GitHub 账号密码；
        // 带了凭据但密钥错 → 401 挑战让 git 重新提示（此时语境就是镜像密钥）
        return new Response(
          hasCreds
            ? "invalid git access key."
            : "git clone is not allowed anonymously on this mirror. Use: git clone https://<user>:<key>@this-mirror/... (contact the maintainer for a key)",
          {
            status: hasCreds ? 401 : 403,
            headers: hasCreds
              ? {
                  "content-type": "text/plain; charset=utf-8",
                  "www-authenticate":
                    'Basic realm="git mirror", charset="UTF-8"',
                }
              : { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
      // 本人放行：剥掉密钥头，继续正常路由
      const strippedHeaders = new Headers(request.headers);
      strippedHeaders.delete("authorization");
      request = new Request(request, { headers: strippedHeaders });
    }
    if (isProxyDownload) {
      // 补全成完整 GitHub 直链，避免加速站无法解析：
      //  - 已带协议：原样；
      //  - github.com 开头：补 https://；
      //  - 裸 owner/repo 形式（镜像约定省略了 github.com）：补 https://github.com/
      if (!/^https?:\/\//i.test(path)) {
        path = /^github\.com\//i.test(path)
          ? "https://" + path
          : "https://github.com/" + path;
      }
      // 重定向到加速站；302 临时跳转，浏览器不缓存，重复点击可重新抽站
      return Response.redirect(pickProxySite() + path, 302);
    }
    // raw 文件路由：必须先于通用代理链处理——
    // 原实现里 jsDelivr 分支排在通用代理之后（RE_RAW_FILE 已被上方链路命中），
    // 导致 jsdelivr 开关从未生效过。
    // 开关开 → 302 至 jsDelivr；新版 /refs/heads|tags/ 路由先归一化为 @分支 形式；
    // 开关关 → 走自身代理
    if (path.search(RE_RAW_FILE) === 0) {
      if (Config.jsdelivr) {
        // 新版 /refs/heads|tags/ 路由与老格式 分支直写在路径中 的归一化规则互斥，
        // 不能连续替换，否则会拼出 @@main 双 @ 坏地址
        const jsdelivrUrl = /\/refs\/(?:heads|tags)\//i.test(path)
          ? path
              .replace(/\/refs\/(?:heads|tags)\//i, "@") // refs/heads/main → @main
              .replace(
                /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/i,
                "https://cdn.jsdelivr.net/gh",
              )
          : path
              .replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, "@$1") // owner/repo/BRANCH/ → owner/repo@BRANCH/
              .replace(
                /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/i,
                "https://cdn.jsdelivr.net/gh",
              );
        return Response.redirect(jsdelivrUrl, 302);
      }
      return httpHandler(request, path);
    }
    if (
      path.search(RE_GITHUB_REPO) === 0 ||
      path.search(RE_GIST_FILE) === 0 ||
      path.search(RE_GITHUB_TAGS) === 0 ||
      path.search(RE_GIT_INFO) === 0
    ) {
      return httpHandler(request, path); // 处理符合正则的请求
    } else if (path.search(RE_GITHUB_BLOB_RAW) === 0) {
      if (Config.jsdelivr) {
        const jsdelivrUrl = path
          .replace("/blob/", "@")
          .replace(
            /^(?:https?:\/\/)?github\.com/,
            "https://cdn.jsdelivr.net/gh",
          ); // 使用jsDelivr镜像
        return Response.redirect(jsdelivrUrl, 302); // 重定向到jsDelivr
      } else {
        path = path.replace("/blob/", "/raw/"); // 修改路径为raw
        return httpHandler(request, path); // 处理修改后的请求
      }
    } else {
      if (env.URL302) {
        return Response.redirect(env.URL302, 302);
      } else if (env.URL) {
        if (env.URL.toLowerCase() == "nginx") {
          //首页改成一个nginx伪装页
          return new Response(await nginx(), {
            headers: {
              "Content-Type": "text/html; charset=UTF-8",
            },
          });
        } else return fetch(new Request(env.URL, request));
      } else {
        return new Response(await githubInterface(), {
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
          },
        });
      }
    }
  },
};

async function githubInterface() {
  const html = `
		<!DOCTYPE html>
		<html lang="zh-CN">
		<head>
			<title>GitHub 文件加速</title>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				:root {
					--primary-color: #0d1117;
					--secondary-color: #161b22;
					--text-color: #f0f6fc;
					--accent-color: #58a6ff;
					--gradient-start: #24292e;
					--gradient-end: #0d1117;
					--shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
					--border-color: rgba(255, 255, 255, 0.1);
					--github-corner-bg: #f0f6fc;
					--github-corner-fg: rgb(21,26,31);
				}

				* {
					box-sizing: border-box;
					margin: 0;
					padding: 0;
				}

				body {
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
					min-height: 100vh;
					background: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
					color: var(--text-color);
					display: flex;
					justify-content: center;
					align-items: center;
					padding: 20px;
				}

				.container {
					width: 100%;
					max-width: 800px;
					padding: 40px 20px;
					text-align: center;
				}

				.title {
					font-size: 2.5rem;
					font-weight: 600;
					margin-bottom: 1.5rem;
					color: var(--text-color);
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
					letter-spacing: -0.5px;
				}

				.title .emoji {
					display: inline-block;
					color: #f1fa8c;
					margin-right: 8px;
				}

				.tips a {
					color: var(--accent-color);
					text-decoration: none;
					border-bottom: 1px dashed rgba(88, 166, 255, 0.5);
					transition: all 0.2s ease;
				}

				.tips a:hover {
					color: #a2d2ff;
					border-bottom-color: #a2d2ff;
				}

				.search-container {
					position: relative;
					max-width: 600px;
					margin: 2rem auto;
				}

				.search-input {
					width: 100%;
					height: 56px;
					padding: 0 60px 0 24px;
					font-size: 1rem;
					color: #1f2937;
					background: rgba(255, 255, 255, 0.95);
					border: 2px solid transparent;
					border-radius: 12px;
					box-shadow: var(--shadow);
					transition: all 0.3s ease;
				}

				.search-input:focus {
					border-color: var(--accent-color);
					background: white;
					outline: none;
					box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.3);
				}

				.search-button {
					position: absolute;
					right: 8px;
					top: 50%;
					transform: translateY(-50%);
					width: 44px;
					height: 44px;
					border: none;
					border-radius: 8px;
					background: var(--accent-color);
					color: white;
					cursor: pointer;
					transition: all 0.2s ease;
				}

				.search-button:hover {
					background: #4187d7;
					transform: translateY(-50%) scale(1.05);
				}

				.tips {
					margin-top: 2rem;
					color: rgba(240, 246, 252, 0.8);
					line-height: 1.6;
					text-align: left;
					padding-left: 1.8rem;
				}

				.example-title {
					color: var(--accent-color);
					margin-bottom: 1.5rem;
					font-size: 1.1rem;
					font-weight: 600;
					position: relative;
					padding-bottom: 0.8rem;
					border-bottom: 1px solid var(--border-color);
				}

				.example p {
					margin: 0.9rem 0;
					font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
					font-size: 0.95rem;
					color: rgba(240, 246, 252, 0.9);
					padding-left: 1.5rem;
					line-height: 1.4;
					word-wrap: break-word;
					word-break: break-all;
					overflow-wrap: break-word;
				}

				.example {
					margin-top: 2.5rem;
					padding: 1.8rem;
					background: rgba(255, 255, 255, 0.05);
					border-radius: 12px;
					text-align: left;
					border: 1px solid var(--border-color);
					box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
					overflow-x: auto;
				}

				.url-part {
					color: var(--accent-color);
				}

				.github-corner {
					position: fixed;
					top: 0;
					right: 0;
					z-index: 999;
				}

				.github-corner svg {
					fill: var(--github-corner-bg);
					color: var(--github-corner-fg);
					position: absolute;
					top: 0;
					border: 0;
					right: 0;
					width: 80px;
					height: 80px;
				}

				.github-corner a,
				.github-corner a:visited {
					color: var(--github-corner-fg) !important;
				}

				.github-corner a,
				.github-corner a:visited {
					color: transparent !important;
					text-decoration: none !important;
				}

				.github-corner .octo-body,
				.github-corner .octo-arm {
					fill: var(--github-corner-fg) !重要;
				}

				.github-corner:hover .octo-arm {
					animation: octocat-wave 560ms ease-in-out;
				}

				@keyframes octocat-wave {
					0%, 100% { transform: rotate(0); }
					20%, 60% { transform: rotate(-25deg); }
					40%, 80% { transform: rotate(10deg); }
				}

				@media (max-width: 640px) {
					.container {
						padding: 20px;
					}

					.title {
						font-size: 2rem;
					}

					.search-input {
						height: 50px;
						font-size: 0.9rem;
					}

					.search-button {
						width: 38px;
						height: 38px;
					}

					.example {
						padding: 1rem;
					}

					.example p {
						font-size: 0.85rem;
						padding-left: 0.8rem;
						margin: 0.7rem 0;
					}

					.example-title {
						font-size: 0.95rem;
						padding-bottom: 0.6rem;
					}

					.github-corner svg {
						width: 60px;
						height: 60px;
					}
				}
			</style>
			<script src="https://cdn.jsdelivr.net/gh/watchern/reword@master/i.js" type="text/javascript">
			</script>
		</head>
		<body>
			<a href="https://github.com/watchern/CF-Workers-GitHub" target="_blank" class="github-corner" aria-label="View source on Github">
				<svg viewBox="0 0 250 250" aria-hidden="true">
					<path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
					<path d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
					<path d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor" class="octo-body"></path>
				</svg>
			</a>

			<div class="container">
				<h1 class="title"><span class="emoji">📦</span>GitHub 文件加速</h1>

				<form onsubmit="toSubmit(event)" class="search-container">
					<input
						type="text"
						class="search-input"
						name="q"
						placeholder="请输入 GitHub 文件链接"
						pattern="^((https|http):\/\/)?(github\.com\/.+?\/.+?\/(?:releases|archive|blob|raw|suites)|((?:raw|gist)\.(?:githubusercontent|github)\.com))\/.+$"
						required
					>
					<button type="submit" class="search-button">
						<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
							<path d="M13 5l7 7-7 7M5 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</button>
				</form>

				<div class="tips">
					<p>✨ 支持带协议头(https://)或不带的GitHub链接，更多用法见<a href="https://hunsh.net/archives/23/">文档说明</a></p>
					<p>🚀 release、archive使用cf加速，文件会跳转至JsDelivr</p>
					<p>⚠️ 注意：暂不支持文件夹下载</p>
				</div>

				<div class="example">
					<div class="example-title">📃 合法输入示例：</div>
					<p>📄 分支源码：<span class="url-part">github.com/user/project/archive/master.zip</span></p>
					<p>📁 release源码：<span class="url-part">github.com/user/project/archive/v0.1.0.tar.gz</span></p>
					<p>📂 release文件：<span class="url-part">github.com/user/project/releases/download/v0.1.0/example.zip</span></p>
					<p>💾 commit文件：<span class="url-part">github.com/user/project/blob/123/filename</span></p>
					<p>🖨️ gist：<span class="url-part">gist.githubusercontent.com/cielpy/123/raw/cmd.py</span></p>
				</div>
			</div>

			<script>
				function toSubmit(e) {
					e.preventDefault();
					const input = document.getElementsByName('q')[0];
					const baseUrl = location.origin+'${PREFIX}'
					window.open(baseUrl + input.value);
				}
			</script>
		</body>
		</html>
	`;
  return html;
}

// 解析环境变量中的 UA 黑名单字符串（支持空格/引号/换行分隔）为数组
async function parseUaList(envadd) {
  var addtext = envadd.replace(/[	 |"'\r\n]+/g, ",").replace(/,+/g, ","); // 将空格、双引号、单引号和换行符替换为逗号
  if (addtext.charAt(0) == ",") addtext = addtext.slice(1);
  if (addtext.charAt(addtext.length - 1) == ",")
    addtext = addtext.slice(0, addtext.length - 1);
  const add = addtext.split(",");
  return add;
}

async function nginx() {
  const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>

	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>

	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`;
  return text;
}
