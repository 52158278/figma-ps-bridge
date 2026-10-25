param(
    [switch]$Auto
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$srcPs        = Join-Path $root 'ps-cep'
$srcFigmaMan  = Join-Path $root 'figma-plugin\manifest.json'
$srcBridgeBat = Join-Path $root 'bridge\启动桥接.bat'
$extName      = 'figma-ps-bridge'
$cepRoot      = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target       = Join-Path $cepRoot $extName

function Line($text = '') { Write-Host $text }
function Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Err($text)  { Write-Host "  [失败] $text" -ForegroundColor Red }
function Title($text) {
    Write-Host ''
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 52)) -ForegroundColor DarkGray
}

function Get-PythonInvocation {
    # 本机可能只有 py 启动器、python 不在 PATH：按 python → py -3 → py 依次探测
    $candidates = @(
        @{ Exe = 'python'; Args = @() },
        @{ Exe = 'py';     Args = @('-3') },
        @{ Exe = 'py';     Args = @() }
    )
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        foreach ($candidate in $candidates) {
            if (-not (Get-Command $candidate.Exe -ErrorAction SilentlyContinue)) { continue }
            $argv = @($candidate.Args) + '--version'
            $output = ''
            try {
                $output = (& $candidate.Exe @argv 2>&1 | ForEach-Object { "$_" }) -join ' '
            } catch {
                continue
            }
            if ($LASTEXITCODE -ne 0) { continue }
            $m = [regex]::Match($output, 'Python\s+(\d+)\.')
            if (-not $m.Success) { continue }
            $major = [int]$m.Groups[1].Value
            if ($major -lt 3) { continue }
            return [pscustomobject]@{
                Command = ((@($candidate.Exe) + @($candidate.Args)) -join ' ')
                Version = ($output -replace '\s+', ' ').Trim()
                Major   = $major
            }
        }
    } finally {
        $ErrorActionPreference = $saved
    }
    return $null
}

function Test-Python {
    $py = Get-PythonInvocation
    if ($py) {
        Ok "Python 可用（$($py.Version)，命令：$($py.Command)）"
        return $true
    }
    Err ' 没有找到可用的 Python（python / py 均不可用），桥接服务无法启动'
    Warn ' 请到 https://www.python.org/downloads/ 安装 Python 3，安装时勾选 "Add Python to PATH"'
    return $false
}

function Install-CepExtension {
    Title '1/4  安装 Photoshop 扩展'

    if (-not (Test-Path (Join-Path $srcPs 'CSXS\manifest.xml'))) {
        Err "源文件缺失：$srcPs\CSXS\manifest.xml"
        return $false
    }

    if (-not (Test-Path $cepRoot)) {
        New-Item -ItemType Directory -Path $cepRoot -Force | Out-Null
        Ok "创建 CEP 扩展目录：$cepRoot"
    }

    if (Test-Path $target) {
        try {
            Remove-Item -Path $target -Recurse -Force
            Ok "清理旧版本：$target"
        } catch {
            Warn '旧版本文件被占用（Photoshop 可能正在运行），改为覆盖安装'
        }
    }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    try {
        Copy-Item -Path (Join-Path $srcPs '*') -Destination $target -Recurse -Force
    } catch {
        Err "复制失败：$($_.Exception.Message)"
        Warn '请先完全退出 Photoshop，再重新执行 [1] 一键部署'
        return $false
    }

    if (Test-Path (Join-Path $target 'CSXS\manifest.xml')) {
        Ok "扩展已安装到：$target"
        return $true
    }
    Err '扩展复制失败'
    return $false
}

function Set-PlayerDebugMode {
    Title '2/4  解除 CEP 签名校验'

    $done = @()
    foreach ($v in 9..14) {
        $path = "HKCU:\Software\Adobe\CSXS.$v"
        try {
            if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
            New-ItemProperty -Path $path -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
            $done += "CSXS.$v"
        } catch {
            Err "写入 CSXS.$v 失败：$($_.Exception.Message)"
        }
    }
    if ($done.Count -gt 0) { Ok ("PlayerDebugMode=1 已写入：" + ($done -join '、')) }
}

function New-Shortcuts {
    Title '3/4  创建快捷方式'

    if (-not (Test-Path $srcBridgeBat)) {
        Warn "找不到启动脚本：$srcBridgeBat"
        return
    }

    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Join-Path $desktop '启动 PS 桥接.lnk'))
        $lnk.TargetPath = $srcBridgeBat
        $lnk.WorkingDirectory = Split-Path $srcBridgeBat -Parent
        $lnk.Description = 'Figma ⇄ Photoshop 桥接服务'
        $lnk.Save()
        Ok '桌面快捷方式「启动 PS 桥接」已创建'
    } catch {
        Warn "创建快捷方式失败：$($_.Exception.Message)"
    }
}

function Show-FigmaSteps {
    Title '4/4  Figma 插件（需手动，一次性）'

    if (-not (Test-Path $srcFigmaMan)) {
        Err "找不到 Figma 插件清单：$srcFigmaMan"
        return
    }

    Line '  Figma 不允许安装程序自动装插件，需要手动导入一次：'
    Line ''
    Line '    1. 打开 Figma 桌面版（网页版不支持开发插件）'
    Line '    2. 菜单  Figma → 插件 → 开发 → 从清单导入插件...'
    Line '    3. 选择下面这个文件：'
    Line ''
    Write-Host "       $srcFigmaMan" -ForegroundColor White
    Line ''
    Line '    4. 之后从 插件 → 开发 → PS 桥接 打开面板'
    Line ''
    Write-Host '  提示：整个文件夹可以复制到任意位置（U 盘也行），换机器后双击 部署器.bat 跑一次即可。' -ForegroundColor DarkGray
    Write-Host '        文件夹搬家之后，重新执行 [1] 一键部署就能修正桌面快捷方式的路径。' -ForegroundColor DarkGray
    Line ''

    try {
        Set-Clipboard -Value $srcFigmaMan
        Ok '清单路径已复制到剪贴板'
    } catch {}

    try {
        Start-Process explorer.exe "/select,`"$srcFigmaMan`""
        Ok '已在资源管理器中定位到清单文件'
    } catch {}
}

function Find-Bridge {
    # 桥接服务会在 8765-8774 之间自动挑一个空闲端口
    foreach ($port in 8765..8774) {
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
            if ($r.ok) { return @{ port = $port; health = $r } }
        } catch {}
    }
    return $null
}

function Test-Status {
    Title '安装状态检查'

    # 扩展文件
    if (Test-Path (Join-Path $target 'CSXS\manifest.xml')) {
        Ok "PS 扩展：已安装（$target）"
    } else {
        Err 'PS 扩展：未安装'
    }

    # 注册表
    $on = @()
    foreach ($v in 9..14) {
        $p = "HKCU:\Software\Adobe\CSXS.$v"
        if (Test-Path $p) {
            $val = (Get-ItemProperty -Path $p -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode
            if ($val -eq '1') { $on += "CSXS.$v" }
        }
    }
    if ($on.Count -gt 0) { Ok ("免签名开关：" + ($on -join '、')) } else { Err '免签名开关：未设置' }

    # Python / 桥接
    Test-Python | Out-Null
    $bridge = Find-Bridge
    if ($bridge) {
        $psState = if ($bridge.health.psOnline) { '已连接' } else { '未连接' }
        Ok ("桥接服务：运行中（127.0.0.1:" + $bridge.port + "，PS 面板 " + $psState + "）")
    } else {
        Warn '桥接服务：未运行（双击「启动 PS 桥接」）'
    }

    # Photoshop 进程
    $ps = Get-Process -Name Photoshop -ErrorAction SilentlyContinue
    if ($ps) { Warn 'Photoshop 正在运行 —— 装完扩展需要重启 PS 才会出现在「窗口 → 扩展(旧版)」' }
    else { Ok 'Photoshop：未运行（下次启动即可看到扩展）' }
}

function Start-Bridge {
    if (-not (Test-Path $srcBridgeBat)) { Err "找不到：$srcBridgeBat"; return }
    try {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$srcBridgeBat`""
        Start-Sleep -Milliseconds 1500
        $bridge = Find-Bridge
        if ($bridge) {
            Ok ("桥接服务已启动（127.0.0.1:" + $bridge.port + "）")
        } else {
            throw '服务未响应'
        }
    } catch {
        Warn '服务未响应，请查看弹出的黑窗口里的报错'
    }
}

function Invoke-FullDeploy {
    Write-Host ''
    Write-Host '  Figma ⇄ Photoshop 位图桥接 · 部署器' -ForegroundColor White
    Write-Host '  ----------------------------------------------------' -ForegroundColor DarkGray

    Test-Python | Out-Null

    if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) {
        Warn 'Photoshop 正在运行，安装完成后需要重启 Photoshop 才能看到扩展'
    }

    $okExt = Install-CepExtension
    Set-PlayerDebugMode
    New-Shortcuts
    if ($okExt) { Show-FigmaSteps }
    Test-Status

    Write-Host ''
    if ($okExt) {
        Write-Host '  部署完成。' -ForegroundColor Green
        Line '  下一步：重启 Photoshop → 窗口 → 扩展(旧版) → Figma 桥接'
        Line '         双击桌面「启动 PS 桥接」保持桥接服务运行'
    } else {
        Write-Host '  部署未完全成功，请把上面的 [失败] 行发给我。' -ForegroundColor Red
    }
    Write-Host ''
}

if ($Auto) {
    Invoke-FullDeploy
    exit 0
}

while ($true) {
    Write-Host ''
    Write-Host '  ========  Figma ⇄ Photoshop 桥接 · 部署器  ========' -ForegroundColor Cyan
    Line '  [1] 一键部署（PS 扩展 + 注册表 + 快捷方式）'
    Line '  [2] 检查安装状态'
    Line '  [3] 启动桥接服务'
    Line '  [4] 查看 Figma 插件导入步骤（并定位清单文件）'
    Line '  [5] 打开扩展安装目录'
    Line '  [0] 退出'
    Write-Host ''
    $choice = Read-Host '  请选择'

    switch ($choice.Trim()) {
        '1' { Invoke-FullDeploy }
        '2' { Test-Status }
        '3' { Start-Bridge }
        '4' { Show-FigmaSteps }
        '5' {
            if (Test-Path $target) { Start-Process explorer.exe $target }
            else { Warn '扩展尚未安装，请先执行 [1]' }
        }
        '0' { return }
        default { Warn '无效选项，请输入 0-5' }
    }
}
