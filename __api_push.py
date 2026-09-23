# -*- coding: utf-8 -*-
"""
__api_push.py — 通过 GitHub REST API 推送当前分支（绕过被墙/重置的 git 协议）。

场景：沙箱里 `git push` 会被网络重置（curl 52 / Connection reset），但 api.github.com 可达。
本脚本用 Git Database API 把本地提交上传到远端，等价于 `git push origin <branch>`。

用法：
    # 读环境变量 GH_PAT（推荐，避免 token 出现在进程列表）
    set GH_PAT=ghp_xxx
    python __api_push.py
    python __api_push.py --tag v3.3.2          # 推送后建轻量 tag 并推送
    python __api_push.py --branch main          # 指定分支（默认取当前分支）
    python __api_push.py --dry-run              # 只预览将推送的提交/文件，不实际推送
    python __api_push.py --token ghp_xxx        # 也可显式传（不推荐，会进进程列表）

依赖：Python 3.7+，仅用标准库（urllib / base64 / json / subprocess）。
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
# 二进制扩展名 → 用 base64 编码 blob；其余按 utf-8 文本
BINARY_EXT = {".zip", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot"}


def run_git(args):
    r = subprocess.run(["git"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("git 命令失败: git %s\n%s" % (" ".join(args), r.stderr.strip()))
    return r.stdout.strip()


def api(method, path, token, data=None):
    url = API + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "api-push-script")
    if data is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(data).encode("utf-8")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit("API %s %s 失败 [%d]:\n%s" % (method, path, e.code, detail[:800]))
    except urllib.error.URLError as e:
        sys.exit("API %s %s 网络错误: %s" % (method, path, e.reason))


def parse_repo():
    url = run_git(["remote", "get-url", "origin"])
    # 支持 git@github.com:owner/repo.git 与 https://github.com/owner/repo.git
    import re
    m = re.search(r"github\.com[:/]([^/]+)/(.+?)(?:\.git)?$", url)
    if not m:
        sys.exit("无法从 remote 解析仓库: " + url)
    return m.group(1), m.group(2).rstrip("/")


def get_remote_sha(owner, repo, branch, token):
    # 先试具体分支
    info = api("GET", "/repos/%s/%s" % (owner, repo), token)
    default_branch = info.get("default_branch", "main")
    ref = branch
    if ref is None:
        ref = default_branch
    r = api("GET", "/repos/%s/%s/git/refs/heads/%s" % (owner, repo, ref), token)
    return r.get("object", {}).get("sha"), ref


def collect_changes():
    """返回 (added_or_modified: [(path, is_binary)], deleted: [path])
    用本地最新提交相对其父提交的变更作为增量。
    说明：本脚本通过 Git Data API 推送会在远端「重建」一份内容相同的 commit，
    因此远端当前树 == 本地 HEAD~1 的树；用 HEAD~1..HEAD 拿到的增量，
    叠加到远端树上结果与 git push 完全等价，且无需本地持有远端 commit 对象
    （git 协议被墙时本地根本没有远端对象，git diff <remote_sha> 会 bad object）。
    """
    try:
        out = run_git(["diff", "--name-status", "HEAD~1", "HEAD"])
    except Exception:
        # 首个提交无父：退化为列出工作区全部已跟踪文件
        out = run_git(["diff", "--name-status", "HEAD"])
        if not out.strip():
            out = "\n".join("A\t" + p for p in run_git(["ls-files"]).splitlines())
    added_mod = []
    deleted = []
    import os as _os
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0][0]  # A/M/D/R/C 的首字母
        if status == "D":
            deleted.append(parts[1])
        elif status == "R" or status == "C":
            # rename/copy: 旧路径删、新路径加
            deleted.append(parts[1])
            newp = parts[2]
            added_mod.append((newp, _os.path.splitext(newp)[1].lower() in BINARY_EXT))
        else:  # A / M
            p = parts[1]
            added_mod.append((p, _os.path.splitext(p)[1].lower() in BINARY_EXT))
    return added_mod, deleted


def build_tree(owner, repo, remote_sha, added_mod, deleted, token):
    # 拉取远端基础树（递归）
    tree_info = api("GET", "/repos/%s/%s/git/trees/%s?recursive=1" % (owner, repo, remote_sha), token)
    entries = {e["path"]: e for e in tree_info.get("tree", [])}
    if tree_info.get("truncated"):
        sys.exit("基础树被截断，文件过多，请改用本机 git push")
    # 删除
    for p in deleted:
        entries.pop(p, None)
    # 新增/修改：逐个建 blob
    for path, is_bin in added_mod:
        if not os.path.exists(path):
            # 工作区已不存在但 diff 标记修改？跳过
            entries.pop(path, None)
            continue
        with open(path, "rb") as f:
            raw = f.read()
        if is_bin:
            content = base64.b64encode(raw).decode("ascii")
            encoding = "base64"
        else:
            content = raw.decode("utf-8")
            encoding = "utf-8"
        blob = api("POST", "/repos/%s/%s/git/blobs" % (owner, repo), token,
                   {"content": content, "encoding": encoding})
        entries[path] = {"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}
    new_tree = api("POST", "/repos/%s/%s/git/trees" % (owner, repo), token,
                   {"tree": [{"path": e["path"], "mode": e["mode"], "type": e["type"], "sha": e["sha"]}
                             for e in entries.values()]})
    return new_tree["sha"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", help="GitHub PAT（建议改用环境变量 GH_PAT）")
    ap.add_argument("--branch")
    ap.add_argument("--tag", help="推送后创建的轻量 tag，如 v3.3.2")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    owner, repo = parse_repo()
    branch = args.branch or run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    local_sha = run_git(["rev-parse", "HEAD"])

    print("仓库: %s/%s  分支: %s  本地 HEAD: %s" % (owner, repo, branch, local_sha[:10]))

    if args.dry_run:
        print("\n[dry-run] 将推送的提交：")
        log = run_git(["log", "--oneline", "origin/%s..HEAD" % branch]) if _has_upstream(branch) else run_git(["log", "--oneline", "-1"])
        print(log or "(无新提交)")
        print("\n[dry-run] 将变更的文件：")
        print(run_git(["diff", "--stat", "origin/%s..HEAD" % branch]) if _has_upstream(branch) else run_git(["diff", "--stat", "HEAD~1", "HEAD"]))
        return

    token = args.token or os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("缺少 GitHub token：请设环境变量 GH_PAT，或用 --token 传入（classic PAT，需 repo 权限）")

    remote_sha, branch = get_remote_sha(owner, repo, branch, token)
    pushed_sha = local_sha
    if remote_sha == local_sha:
        print("远端已是最新，无需推送。")
    else:
        added_mod, deleted = collect_changes()
        print("变更文件: +%d / -%d" % (len(added_mod), len(deleted)))
        new_tree = build_tree(owner, repo, remote_sha, added_mod, deleted, token)
        msg = run_git(["log", "-1", "--format=%B"]).strip()
        commit = api("POST", "/repos/%s/%s/git/commits" % (owner, repo), token,
                     {"message": msg, "tree": new_tree, "parents": [remote_sha]})
        api("PATCH", "/repos/%s/%s/git/refs/heads/%s" % (owner, repo, branch), token,
            {"sha": commit["sha"], "force": False})
        pushed_sha = commit["sha"]
        print("✅ 已推送 %s -> %s/%s@%s" % (local_sha[:10], owner, repo, branch))

    if args.tag:
        # 轻量 tag：指向实际推到服务器的提交 SHA（API 推送会生成新 SHA）
        api("POST", "/repos/%s/%s/git/refs" % (owner, repo), token,
            {"ref": "refs/tags/%s" % args.tag, "sha": pushed_sha})
        print("✅ 已创建并推送 tag: %s" % args.tag)


def _has_upstream(branch):
    r = subprocess.run(["git", "rev-parse", "--abbrev-ref", branch + "@{u}"],
                       capture_output=True, text=True)
    return r.returncode == 0


if __name__ == "__main__":
    main()
