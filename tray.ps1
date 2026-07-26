Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Get script directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$script:lastStatus = $null
$icon = New-Object System.Windows.Forms.NotifyIcon

function Set-IconColor($color) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'HighQuality'
    $brush = @{
        online  = [System.Drawing.Brushes]::LimeGreen
        stopped = [System.Drawing.Brushes]::Red
        errored = [System.Drawing.Brushes]::OrangeRed
    }
    $b = $brush[$color]
    if (-not $b) { $b = [System.Drawing.Brushes]::Gray }
    $g.FillEllipse($b, 1, 1, 14, 14)
    $g.FillEllipse([System.Drawing.Brushes]::White, 5, 4, 6, 8)
    $g.Dispose()
    $icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function Get-BotStatus {
    try {
        $r = pm2 status astra --no-color 2>&1
        if ($r -match 'errored')   { return 'errored' }
        if ($r -match 'online')    { return 'online' }
        if ($r -match 'stopped')   { return 'stopped' }
        return 'not found'
    } catch { return 'error' }
}

# context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$showItem = New-Object System.Windows.Forms.ToolStripMenuItem('Show Status')
$showItem.Add_Click({
    $s = Get-BotStatus
    [System.Windows.Forms.MessageBox]::Show("Astra Bot: $s", 'Astra Status', 'OK', 'Information')
})
$menu.Items.Add($showItem) | Out-Null

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem('Restart Bot')
$restartItem.Add_Click({
    pm2 restart astra
    $icon.ShowBalloonTip(3000, 'Astra', 'Bot restart initiated', [System.Windows.Forms.ToolTipIcon]::Info)
})
$menu.Items.Add($restartItem) | Out-Null

$menu.Items.Add('-') | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Exit Tray')
$exitItem.Add_Click({
    $icon.Visible = $false
    $icon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitItem) | Out-Null

$icon.ContextMenuStrip = $menu
$icon.Text = 'Astra Bot - ...'
Set-IconColor 'gray'
$icon.Visible = $true

# click to show status
$icon.Add_Click({
    if ($_.Button -eq 'Left') {
        $s = Get-BotStatus
        $icon.ShowBalloonTip(2000, 'Astra Bot', $s, [System.Windows.Forms.ToolTipIcon]::Info)
    }
})

# poll every 5s
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    $s = Get-BotStatus
    if ($s -ne $script:lastStatus) {
        $script:lastStatus = $s
        $icon.Text = "Astra Bot - $s"
        Set-IconColor $s
        if ($s -eq 'online') {
            $icon.ShowBalloonTip(3000, 'Astra', 'Bot is online', [System.Windows.Forms.ToolTipIcon]::Info)
        } elseif ($s -eq 'stopped') {
            $icon.ShowBalloonTip(3000, 'Astra', 'Bot stopped!', [System.Windows.Forms.ToolTipIcon]::Error)
        } elseif ($s -eq 'errored') {
            $icon.ShowBalloonTip(3000, 'Astra', 'Bot errored!', [System.Windows.Forms.ToolTipIcon]::Error)
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
