#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: checkout.sh <repo> [options]

Ensure a cached checkout exists at:
  ~/.cache/checkouts/<host>/<org>/<repo>

Examples:
  checkout.sh openai/openai-python
  checkout.sh github.com/openai/openai-python
  checkout.sh https://github.com/openai/openai-python
  checkout.sh git@github.com:openai/openai-python.git

Options:
  --path-only                 Print only the checkout path.
  --force-update              Always fetch from origin and attempt a fast-forward.
  --update-interval <secs>    Minimum seconds between updates (default: 300).

Environment variables:
  LIBRARIAN_CACHE_ROOT        Override the cache root (default: ~/.cache/checkouts)
  LIBRARIAN_DEFAULT_HOST      Host for owner/repo shorthand (default: github.com)
  LIBRARIAN_UPDATE_INTERVAL   Default update interval (seconds)
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

repo_input=""
path_only=0
force_update=0
update_interval="${LIBRARIAN_UPDATE_INTERVAL:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path-only)
      path_only=1
      shift
      ;;
    --force-update)
      force_update=1
      shift
      ;;
    --update-interval)
      if [[ $# -lt 2 ]]; then
        echo "Error: --update-interval requires a value" >&2
        exit 2
      fi
      update_interval="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$repo_input" ]]; then
        repo_input="$1"
      else
        echo "Error: Unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$repo_input" ]]; then
  echo "Error: A repository is required" >&2
  exit 2
fi

if ! [[ "$update_interval" =~ ^[0-9]+$ ]]; then
  echo "Error: update interval must be a non-negative integer" >&2
  exit 2
fi

trim_repo_input() {
  local s="$1"
  # 去除首尾空白。
  s="${s#${s%%[![:space:]]*}}"
  s="${s%${s##*[![:space:]]}}"
  printf '%s' "$s"
}

parse_repo() {
  local input host path first rest component
  input="$(trim_repo_input "$1")"

  # 对类 URL 输入去除 query/fragment。
  input="${input%%\?*}"
  input="${input%%#*}"

  case "$input" in
    git@*:* )
      host="${input#git@}"
      host="${host%%:*}"
      path="${input#*:}"
      ;;
    ssh://* )
      rest="${input#ssh://}"
      host="${rest%%/*}"
      host="${host#*@}"
      path="${rest#*/}"
      ;;
    http://*|https://* )
      rest="${input#*://}"
      host="${rest%%/*}"
      path="${rest#*/}"
      ;;
    */* )
      first="${input%%/*}"
      if [[ "$first" == *.* || "$first" == localhost ]]; then
        host="$first"
        path="${input#*/}"
      else
        host="${LIBRARIAN_DEFAULT_HOST:-github.com}"
        path="$input"
      fi
      ;;
    * )
      echo "Error: Unsupported repository format: $input" >&2
      return 1
      ;;
  esac

  host="${host#*@}"
  path="${path#/}"
  path="${path%/}"

  # 对于类 GitHub 的深层链接，只使用 owner/repo。
  IFS='/' read -r -a parts <<< "$path"
  if [[ ${#parts[@]} -ge 3 ]]; then
    case "${parts[2]}" in
      tree|blob|pull|issues|commit|actions|releases|compare|wiki)
        path="${parts[0]}/${parts[1]}"
        ;;
    esac
  fi

  # 去除可选的 .git 后缀。
  path="${path%.git}"

  if ! [[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?$ ]] ||
     [[ "$host" == *..* || "$path" == *//* ]]; then
    echo "Error: Invalid repository host or path" >&2
    return 1
  fi
  IFS='/' read -r -a parts <<< "$path"
  if [[ ${#parts[@]} -lt 2 ]]; then
    echo "Error: Repository path must contain at least org/repo: $path" >&2
    return 1
  fi
  for component in "${parts[@]}"; do
    if [[ "$component" == . || "$component" == .. ]] ||
       ! [[ "$component" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
      echo "Error: Invalid repository path component: $component" >&2
      return 1
    fi
  done

  local last_index=$(( ${#parts[@]} - 1 ))
  local repo="${parts[$last_index]}"
  local org_parts=("${parts[@]:0:$last_index}")
  local org
  org="$(IFS='/'; echo "${org_parts[*]}")"

  if [[ -z "$host" || -z "$org" || -z "$repo" ]]; then
    echo "Error: Failed to parse repository: $input" >&2
    return 1
  fi

  printf '%s\n%s\n%s\n' "$host" "$org" "$repo"
}

parsed_host=""
parsed_org=""
parsed_repo=""
parsed_index=0
# command substitution 的失败会传播；process substitution 不会。
parsed="$(parse_repo "$repo_input")"
while IFS= read -r line; do
  case "$parsed_index" in
    0) parsed_host="$line" ;;
    1) parsed_org="$line" ;;
    2) parsed_repo="$line" ;;
  esac
  parsed_index=$((parsed_index + 1))
done <<< "$parsed"

host="$parsed_host"
org="$parsed_org"
repo="$parsed_repo"

cache_root="${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}"
mkdir -p "$cache_root"
cache_root="$(cd "$cache_root" && pwd -P)"
checkout_path="$cache_root/$host/$org/$repo"
origin_url="https://$host/$org/$repo.git"

# 不跟随缓存根以下的符号链接，避免把 mkdir 或 Git 操作导向其他仓库。
checked_path="$cache_root"
IFS='/' read -r -a checkout_parts <<< "$host/$org/$repo"
for component in "${checkout_parts[@]}"; do
  checked_path="$checked_path/$component"
  if [[ -L "$checked_path" ]]; then
    echo "Error: Symlink is not allowed in checkout path: $checked_path" >&2
    exit 2
  fi
done
if [[ -L "$checkout_path/.git" ]]; then
  echo "Error: Symlink is not allowed for the checkout Git directory" >&2
  exit 2
fi
mkdir -p "$(dirname "$checkout_path")"

if [[ ! -d "$checkout_path/.git" ]]; then
  git clone --filter=blob:none "$origin_url" "$checkout_path" >/dev/null
  clone_state="cloned"
else
  clone_state="existing"
fi

if [[ ! -d "$checkout_path/.git" ]]; then
  echo "Error: Checkout path is not a Git repository: $checkout_path" >&2
  exit 3
fi

if ! git -C "$checkout_path" remote get-url origin >/dev/null 2>&1; then
  git -C "$checkout_path" remote add origin "$origin_url"
fi

# 如果远端 URL 发生变化（例如 host 简写），规范化为标准的 HTTPS URL。
current_origin="$(git -C "$checkout_path" remote get-url origin 2>/dev/null || true)"
if [[ "$current_origin" != "$origin_url" ]]; then
  git -C "$checkout_path" remote set-url origin "$origin_url"
fi

last_fetch_file="$checkout_path/.git/librarian-last-fetch"
now_epoch="$(date +%s)"
needs_update=1

if [[ -f "$last_fetch_file" && "$force_update" -eq 0 ]]; then
  last_epoch="$(cat "$last_fetch_file" 2>/dev/null || echo 0)"
  if [[ "$last_epoch" =~ ^[0-9]+$ ]]; then
    age=$(( now_epoch - last_epoch ))
    if (( age < update_interval )); then
      needs_update=0
    fi
  fi
fi

update_state="skipped"
ff_state="not-attempted"

if (( needs_update == 1 )); then
  git -C "$checkout_path" fetch --prune --tags origin >/dev/null
  echo "$now_epoch" > "$last_fetch_file"
  update_state="fetched"

  branch="$(git -C "$checkout_path" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  upstream="$(git -C "$checkout_path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  dirty="$(git -C "$checkout_path" status --porcelain --untracked-files=no)"

  if [[ -n "$branch" && -n "$upstream" && -z "$dirty" ]]; then
    if git -C "$checkout_path" merge --ff-only "$upstream" >/dev/null 2>&1; then
      ff_state="fast-forwarded"
    else
      ff_state="skipped-non-ff"
    fi
  elif [[ -n "$dirty" ]]; then
    ff_state="skipped-dirty"
  else
    ff_state="skipped-no-upstream"
  fi
fi

if (( path_only == 1 )); then
  printf '%s\n' "$checkout_path"
  exit 0
fi

cat <<EOF
repo: $host/$org/$repo
path: $checkout_path
state: $clone_state
update: $update_state
fast_forward: $ff_state
EOF
