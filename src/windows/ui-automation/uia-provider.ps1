# Fixed Windows UI Automation provider. It accepts a structured JSON request on
# stdin; it never evaluates model text as PowerShell or as a command.
$ErrorActionPreference = 'Stop'
$providerReady = $false

function Result-Failure($code, $message) {
    return @{ success = $false; error = @{ code = $code; message = $message } }
}

function Get-ElementMetadata($element, $maxTextLength) {
    $current = $element.Current
    $patterns = [System.Collections.Generic.List[string]]::new()
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $patterns.Add('Invoke') }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $patterns.Add('Value') }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { $patterns.Add('Text') }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $patterns.Add('SelectionItem') }
    return @{
        name = ([string]$current.Name).Substring(0, [Math]::Min(([string]$current.Name).Length, $maxTextLength))
        controlType = ([string]$current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        automationId = [string]$current.AutomationId
        enabled = [bool]$current.IsEnabled
        focusable = [bool]$current.IsKeyboardFocusable
        patterns = @($patterns.ToArray())
    }
}

function Get-ControlChildren($element) {
    $children = [System.Collections.Generic.List[object]]::new()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child -and $children.Count -lt 500) {
        $children.Add($child)
        $child = $walker.GetNextSibling($child)
    }
    return ,$children.ToArray()
}

function Same-Metadata($actual, $expected) {
    foreach ($key in @('name', 'controlType', 'automationId')) {
        if ([string]$actual[$key] -cne [string]$expected.$key) { return $false }
    }
    return $true
}

function Resolve-Element($root, $request) {
    $path = @($request.locator.path)
    if ($path.Count -eq 0 -or $path.Count -gt 16) { return $null }
    $element = $root
    foreach ($index in $path) {
        if ($index -isnot [int] -or $index -lt 0) { return $null }
        $children = Get-ControlChildren $element
        if ($index -ge $children.Count) { return $null }
        $element = $children[$index]
    }
    if ($request.locator.runtimeId) {
        $actualRuntimeId = @($element.GetRuntimeId())
        $savedRuntimeId = @($request.locator.runtimeId)
        if (($actualRuntimeId -join ',') -cne ($savedRuntimeId -join ',')) { return $null }
    }
    $actual = Get-ElementMetadata $element 300
    if (-not (Same-Metadata $actual $request.expected)) { return $null }
    return $element
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $providerReady = $true
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($null -eq $request -or $request.windowHandle -notmatch '^0x[0-9a-fA-F]+$') {
        $response = Result-Failure 'invalid_request' 'La solicitud UI Automation no es válida.'
    } else {
        $handleValue = [Convert]::ToInt64($request.windowHandle.Substring(2), 16)
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($handleValue))
        if ($null -eq $root) {
            $response = Result-Failure 'window_not_found' 'Windows UI Automation no encontró la ventana.'
        } elseif ($request.operation -eq 'inspect') {
            $maxDepth = [Math]::Max(1, [Math]::Min(6, [int]$request.maxDepth))
            $maxElements = [Math]::Max(1, [Math]::Min(150, [int]$request.maxElements))
            $maxTextLength = [Math]::Max(20, [Math]::Min(300, [int]$request.maxTextLength))
            $queue = [System.Collections.Generic.Queue[object]]::new()
            $rootChildren = Get-ControlChildren $root
            for ($index = 0; $index -lt $rootChildren.Count; $index++) {
                $queue.Enqueue(@{ element = $rootChildren[$index]; path = @($index); depth = 1 })
            }
            $items = [System.Collections.Generic.List[object]]::new()
            $visited = 0
            $truncated = $false
            while ($queue.Count -gt 0 -and $visited -lt $maxElements) {
                $entry = $queue.Dequeue()
                $visited++
                $metadata = Get-ElementMetadata $entry.element $maxTextLength
                if ($metadata.name -or $metadata.patterns.Count -gt 0) {
                    $items.Add(@{ path = @($entry.path); runtimeId = @($entry.element.GetRuntimeId()); name = $metadata.name; controlType = $metadata.controlType; automationId = $metadata.automationId; enabled = $metadata.enabled; focusable = $metadata.focusable; patterns = $metadata.patterns })
                }
                if ($entry.depth -lt $maxDepth) {
                    $children = Get-ControlChildren $entry.element
                    for ($index = 0; $index -lt $children.Count; $index++) {
                        if ($visited + $queue.Count -ge $maxElements) { $truncated = $true; break }
                        $queue.Enqueue(@{ element = $children[$index]; path = @($entry.path) + @($index); depth = $entry.depth + 1 })
                    }
                } elseif ((Get-ControlChildren $entry.element).Count -gt 0) {
                    $truncated = $true
                }
            }
            if ($queue.Count -gt 0 -or $visited -ge $maxElements) { $truncated = $true }
            $response = @{ success = $true; elements = @($items.ToArray()); truncated = $truncated }
        } else {
            $element = Resolve-Element $root $request
            if ($null -eq $element) {
                $response = Result-Failure 'stale_ui_reference' 'El control cambió o ya no está disponible.'
            } else {
                $current = $element.Current
                if (-not $current.IsEnabled) {
                    $response = Result-Failure 'element_disabled' 'El control está deshabilitado.'
                } else {
                    switch ($request.operation) {
                        'focus' {
                            $element.SetFocus()
                            $response = @{ success = $true; action = 'focus' }
                        }
                        'invoke' {
                            $pattern = $null
                            if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                                $response = Result-Failure 'pattern_not_supported' 'El control no soporta el patrón Invoke.'
                            } else {
                                $pattern.Invoke()
                                $response = @{ success = $true; action = 'invoke'; sensitivity = 'may_be_sensitive' }
                            }
                        }
                        'set_value' {
                            $pattern = $null
                            if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                                $response = Result-Failure 'pattern_not_supported' 'El control no soporta el patrón Value.'
                            } elseif ($pattern.Current.IsReadOnly) {
                                $response = Result-Failure 'pattern_not_supported' 'El control de texto es de solo lectura.'
                            } else {
                                $pattern.SetValue([string]$request.value)
                                $response = @{ success = $true; action = 'set_value'; sensitivity = 'may_be_sensitive' }
                            }
                        }
                        'get_value' {
                            $pattern = $null
                            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                                $value = [string]$pattern.Current.Value
                            } else {
                                $pattern = $null
                                if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                                    $response = Result-Failure 'pattern_not_supported' 'El control no expone un valor accesible.'
                                    break
                                }
                                $value = [string]$pattern.DocumentRange.GetText(1001)
                            }
                            $response = @{ success = $true; value = $value.Substring(0, [Math]::Min($value.Length, 1000)); truncated = ($value.Length -gt 1000) }
                        }
                        default { $response = Result-Failure 'invalid_operation' 'La acción UI Automation solicitada no es válida.' }
                    }
                }
            }
        }
    }
} catch {
    if (-not $providerReady) {
        $response = Result-Failure 'ui_automation_unavailable' 'Las APIs UI Automation de Windows no están disponibles.'
    } elseif ($request.operation -eq 'inspect') {
        $response = Result-Failure 'window_not_found' 'Windows UI Automation no pudo abrir el árbol de esa ventana.'
    } elseif ($_.Exception.GetType().Name -eq 'ElementNotAvailableException') {
        $response = Result-Failure 'stale_ui_reference' 'El control cambió mientras se ejecutaba la acción.'
    } elseif ($request.operation -eq 'focus') {
        $response = Result-Failure 'focus_failed' 'Windows no pudo enfocar el control solicitado.'
    } else {
        $response = Result-Failure 'action_failed' 'Windows UI Automation no pudo completar la operación.'
    }
}

[Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Depth 20 -Compress))
