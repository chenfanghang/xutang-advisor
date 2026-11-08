"""启动使用临时配置文件的浏览器测试应用，不改动用户配置。"""

from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from backend.app import create_app


def main() -> None:
    """测试进程退出时清理临时配置。"""
    with TemporaryDirectory(prefix="xutang-e2e-") as directory:
        application = create_app(Path(directory) / "config.local.json")
        uvicorn.run(application, host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
