# 上传到 GitHub

仓库已在本地初始化完毕（`main` 分支，1 个提交，93 个文件，工作区干净）。
剩下的是「建远程仓库 + 推送」，这一步需要你的 GitHub 凭据，按下面任一方式做。

---

## 前置：本地已完成的检查

| 项 | 结果 |
|---|---|
| 仓库已初始化 | `main` 分支，提交 `23352f8`，93 文件 / 16110 行 |
| 敏感文件 | 无 `.env` / 密钥 / `*.sqlite` / `node_modules`（`.gitignore` 已覆盖） |
| 硬编码密钥扫描 | 仅测试里的假值（`sk-rea...3456` 断言用），非真实凭据 |
| 克隆可还原性 | 从零 clone 后 `pnpm install --frozen-lockfile` + `pnpm verify` 通过（243 项测试全绿） |
| `.git` 体积 | 1.1 MB |

---

## 方式 A：用 gh CLI（推荐，一条命令）

```bash
# 1) 登录（选 HTTPS，按提示走浏览器授权）
gh auth login

# 2) 在项目目录创建远程仓库并推送（private 改 --public 即公开）
cd /root/pol-agent
gh repo create agentx --private --source=. --remote=origin --push
```

完成。`gh repo create` 会自动配好 `origin` 并推送 `main`。

---

## 方式 B：先在网页建空仓库，再推

1. 打开 https://github.com/new
2. 仓库名填 `agentx`，**不要**勾选 "Add a README / .gitignore / license"
   （勾了会生成远程提交，与本地产生分叉，推送会被拒）
3. 建好后依次执行：

```bash
cd /root/pol-agent
git remote add origin https://github.com/<你的用户名>/agentx.git
git push -u origin main
```

---

## 方式 C：SSH

```bash
cd /root/pol-agent
git remote add origin git@github.com:<你的用户名>/agentx.git
git push -u origin main
```

没配过 SSH key 的话先跑 `ssh-keygen -t ed25519 -C "you@example.com"`，
再把 `~/.ssh/id_ed25519.pub` 内容贴到 GitHub → Settings → SSH and GPG keys。

---

## 认证：密码不能用，必须用 token

GitHub 已不支持账号密码推送。HTTPS 方式需要 Personal Access Token：

1. https://github.com/settings/tokens → Generate new token (classic)
2. 勾选 `repo` 权限
3. 推送时 Username 填 GitHub 用户名，Password 填 **token**（不是登录密码）

想免输 token：

```bash
# 让 git 记住凭据（明文存 ~/.git-credentials，注意机器安全）
git config --global credential.helper store
```

或者用 `gh auth login` 一次搞定，它会自动接管 HTTPS 凭据。

---

## 推送后建议做的三件事

### 1. 确认 .env 没被推上去

```bash
git ls-files | grep -i env     # 应该只匹配到 .env.example 之类，不能有 .env
```

### 2. 加 CI（可选）

仓库没有 CI 配置。想让每次 push 自动跑 `pnpm verify`，加 `.github/workflows/ci.yml`：

```yaml
name: CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
```

Node 必须 22+（`node:sqlite` 依赖），CI 里别写成 20。

### 3. 补 LICENSE

当前没有 LICENSE 文件，别人在法律上默认无权使用。要开源就加一个
（MIT / Apache-2.0 之类），否则建议保持 `private`。

---

## 常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `remote: Repository not found` | 仓库名/用户名错，或 token 无 `repo` 权限 | 核对 URL；重新生成带 `repo` 的 token |
| `failed to push some refs ... non-fast-forward` | 远程有本地没有的提交（建仓库时勾了 README） | `git pull --rebase origin main` 后重推 |
| `Support for password authentication was removed` | 用了账号密码 | 改 Personal Access Token |
| `src refspec main does not match any` | 当前分支不是 main | `git branch -M main` 后重推 |
| `fatal: refusing to merge unrelated histories` | 远程是独立历史 | `git pull --allow-unrelated-histories` |

---

## 关于本项目的两个特殊注意点

1. **`packages/*/dist` 不进仓库**（已 gitignore）。别人 clone 后必须
   `pnpm install && pnpm build` 才能跑——这是有意的，避免提交构建产物。
2. **`scripts/package-release.sh` 打的是离线部署包**，与 GitHub 仓库用途不同：
   仓库走「clone + 装依赖 + 构建」，部署包走「解压即用」。两条路都验证过。
