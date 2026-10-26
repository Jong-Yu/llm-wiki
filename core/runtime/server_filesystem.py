"""WSL 저장 서버가 Windows/network/휘발성 mount를 Linux 저장소로 오인하지 않는다."""
from pathlib import Path
import re
import sys

LOCAL_FILESYSTEMS = frozenset({"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs"})


def mount_type(path, mountinfo):
    path = Path(path).resolve(strict=True)
    matched = None
    for line in mountinfo.splitlines():
        left, separator, right = line.partition(" - ")
        if not separator:
            continue
        fields = left.split()
        if len(fields) < 6 or not right.split():
            continue
        mount = Path(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4]))
        if path == mount or mount in path.parents:
            if matched is None or len(mount.parts) > matched[0]:
                matched = (len(mount.parts), right.split()[0])
    return matched[1] if matched else None


def check_linux_paths(paths):
    if sys.platform != "linux":
        raise ValueError("linux_host_required")
    mountinfo = Path("/proc/self/mountinfo").read_text()
    for path in paths:
        if mount_type(path, mountinfo) not in LOCAL_FILESYSTEMS:
            raise ValueError("persistent_linux_filesystem_required")
