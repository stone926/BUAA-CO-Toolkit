# legacy-course-executor（v0.6.3-course1）构建与发布流程

> 角色：对拍当前 fork 新增课程语义的 legacy 执行 reference。
> 审查结论见 `c6197f4-review.md`；资产登记在 `reference-manifest.json`。
> 以下步骤中的 push/上传由仓库 owner（用户）执行；本文件保证任何一台干净机器可重复构建。

## 1. 打 tag

```bash
cd Mars-with-BUAA-CO-extension
git status --short   # 确认工作树干净（sources.txt 删除与 .co/ 未跟踪目录不参与 tag）
git tag v0.6.3-course1 c6197f433e20ac0800a48ea1255053147ade5a77
git push origin v0.6.3-course1
```

## 2. 干净 checkout 构建

```bash
cd /tmp
git clone --branch v0.6.3-course1 --depth 1 https://github.com/stone926/Mars-with-BUAA-CO-extension.git mars-course1
cd mars-course1
# 构建（与仓库自带脚本一致）：
dir /S /B *.java > srcList.txt     # Windows；POSIX 用 find . -name '*.java' > srcList.txt
javac -encoding UTF-8 Mars.java @srcList.txt
jar cmf mainclass.txt Mars_CO_v0.6.3-course1.jar PseudoOps.txt Config.properties Syscall.properties Settings.properties MARSlicense.txt mainclass.txt MipsXRayOpcode.xml registerDatapath.xml controlDatapath.xml ALUcontrolDatapath.xml CreateMarsJar.bat Mars.java Mars.class docs help images mars
```

> 打包文件清单与 `CreateMarsJar.bat` 一致，仅输出名改为
> `Mars_CO_v0.6.3-course1.jar`。JDK 版本与构建环境随 artifact 一起记录。

## 3. 记录 hash 并发布

```bash
certutil -hashfile Mars_CO_v0.6.3-course1.jar SHA256    # Windows
sha256sum Mars_CO_v0.6.3-course1.jar                    # POSIX
# 上传为 GitHub release v0.6.3-course1 的资产 Mars_CO_v0.6.3-course1.jar
```

## 4. 回填 manifest

把上一步得到的字节数与 SHA-256 填入本仓库
`conformance/mips/reference/reference-manifest.json` 的 `legacy-course-executor` 条目，
并将 `status` 改为 `released`。之后 `download-references.mjs` 会按清单下载并 fail-closed 校验。

## 5. 可重建性要求

- 任何后续 conformance 使用该 JAR 前，必须验证其 hash 与 manifest 一致；
- 不允许从本地工作树（可能含未提交改动）或用户配置路径隐式替换该资产；
- 构建环境（JDK 版本、OS）应记录在本次发布的 release notes 中，以便差异复现时重建。
