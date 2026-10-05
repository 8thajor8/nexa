# Fixed Windows UI Automation provider. It accepts a structured JSON request on
# stdin; it never evaluates model text as PowerShell or as a command.
$ErrorActionPreference = 'Stop'
$providerReady = $false

function Result-Failure($code, $message) {
    return @{ success = $false; error = @{ code = $code; message = $message } }
}

function Result-Stale($message, $reason) {
    return @{ success = $false; error = @{ code = 'stale_ui_reference'; message = $message; reason = $reason }; reason = $reason }
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
        automationId = ([string]$current.AutomationId).Substring(0, [Math]::Min(([string]$current.AutomationId).Length, 300))
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

function Get-Identity($element) {
    $current = $element.Current
    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    return @{
        name = $name.Substring(0, [Math]::Min($name.Length, 300))
        controlType = ([string]$current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        automationId = $automationId.Substring(0, [Math]::Min($automationId.Length, 300))
    }
}

function Identity-Matches($actual, $expected) {
    if ([string]$actual.controlType -cne [string]$expected.controlType) { return $false }
    if ([string]$expected.automationId) {
        return [string]$actual.automationId -ceq [string]$expected.automationId
    }
    if ([string]$expected.name) {
        return [string]$actual.name -ceq [string]$expected.name
    }
    return $true
}

function Same-Ancestry($actual, $expected) {
    $actual = @($actual)
    $expected = @($expected)
    if ($expected.Count -eq 0) { return $true }
    if ($actual.Count -lt $expected.Count) { return $false }
    $offset = $actual.Count - $expected.Count
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if (-not (Identity-Matches $actual[$offset + $index] $expected[$index])) { return $false }
    }
    return $true
}

function Get-TreeEntries($root, $maxDepth = 8, $maxNodes = 1000) {
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $entries = [System.Collections.Generic.List[object]]::new()
    $children = Get-ControlChildren $root
    for ($index = 0; $index -lt $children.Count -and $index -lt $maxNodes; $index++) {
        $queue.Enqueue(@{ element = $children[$index]; path = @($index); depth = 1; ancestry = @() })
    }
    $visited = 0
    while ($queue.Count -gt 0 -and $visited -lt $maxNodes) {
        $entry = $queue.Dequeue()
        $visited++
        $entry.identity = Get-Identity $entry.element
        $entry.runtimeId = @($entry.element.GetRuntimeId())
        $entries.Add($entry)
        if ($entry.depth -ge $maxDepth) { continue }
        $children = Get-ControlChildren $entry.element
        $ancestry = @($entry.ancestry) + @($entry.identity)
        for ($index = 0; $index -lt $children.Count; $index++) {
            if ($visited + $queue.Count -ge $maxNodes) { break }
            $queue.Enqueue(@{ element = $children[$index]; path = @($entry.path) + @($index); depth = $entry.depth + 1; ancestry = $ancestry })
        }
    }
    return ,@($entries.ToArray())
}

function Resolve-Element($root, $request) {
    $entries = Get-TreeEntries $root
    $identityMatches = @($entries | Where-Object { Identity-Matches $_.identity $request.expected })
    $savedRuntimeId = @($request.locator.runtimeId)
    if ($savedRuntimeId.Count -gt 0) {
        $runtimeMatches = @($identityMatches | Where-Object { ($_.runtimeId -join ',') -ceq ($savedRuntimeId -join ',') })
        if ($runtimeMatches.Count -eq 1) { return @{ status = 'found'; element = $runtimeMatches[0].element } }
    }

    $contextMatches = @($identityMatches | Where-Object { Same-Ancestry $_.ancestry $request.locator.ancestry })
    if ($contextMatches.Count -eq 1) { return @{ status = 'found'; element = $contextMatches[0].element } }
    if ($contextMatches.Count -gt 1) { return @{ status = 'ambiguous' } }
    if ($identityMatches.Count -eq 1) { return @{ status = 'found'; element = $identityMatches[0].element } }
    if ($identityMatches.Count -gt 1) { return @{ status = 'ambiguous' } }
    return @{ status = 'missing' }
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
                $queue.Enqueue(@{ element = $rootChildren[$index]; path = @($index); depth = 1; ancestry = @() })
            }
            $items = [System.Collections.Generic.List[object]]::new()
            $visited = 0
            $truncated = $false
            while ($queue.Count -gt 0 -and $visited -lt $maxElements) {
                $entry = $queue.Dequeue()
                $visited++
                $metadata = Get-ElementMetadata $entry.element $maxTextLength
                if ($metadata.name -or $metadata.patterns.Count -gt 0) {
                    $items.Add(@{
                        locator = @{ path = @($entry.path); runtimeId = @($entry.element.GetRuntimeId()); ancestry = @($entry.ancestry) }
                        identity = Get-Identity $entry.element
                        name = $metadata.name
                        controlType = $metadata.controlType
                        automationId = $metadata.automationId
                        enabled = $metadata.enabled
                        focusable = $metadata.focusable
                        patterns = $metadata.patterns
                    })
                }
                if ($entry.depth -lt $maxDepth) {
                    $children = Get-ControlChildren $entry.element
                    $ancestry = @($entry.ancestry) + @((Get-Identity $entry.element))
                    for ($index = 0; $index -lt $children.Count; $index++) {
                        if ($visited + $queue.Count -ge $maxElements) { $truncated = $true; break }
                        $queue.Enqueue(@{ element = $children[$index]; path = @($entry.path) + @($index); depth = $entry.depth + 1; ancestry = $ancestry })
                    }
                } elseif ((Get-ControlChildren $entry.element).Count -gt 0) {
                    $truncated = $true
                }
            }
            if ($queue.Count -gt 0 -or $visited -ge $maxElements) { $truncated = $true }
            $response = @{ success = $true; elements = @($items.ToArray()); truncated = $truncated }
        } else {
            $resolved = Resolve-Element $root $request
            if ($resolved.status -eq 'missing') {
                $response = Result-Stale 'El control ya no está disponible.' 'element_disappeared'
            } elseif ($resolved.status -eq 'ambiguous') {
                $response = Result-Failure 'ambiguous_element' 'La referencia coincide ahora con varios controles.'
                $response.error.reason = 're_resolution_ambiguous'
            } else {
                $element = $resolved.element
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
                                $pattern = $null
                                if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
                                    $response = Result-Failure 'text_pattern_read_only' 'El control solo expone TextPattern, que permite leer el texto pero no modificarlo. No se usó teclado ni portapapeles.'
                                } else {
                                    $response = Result-Failure 'pattern_not_supported' 'El control no expone un patrón compatible para modificar su valor.'
                                }
                            } elseif ($pattern.Current.IsReadOnly) {
                                $response = Result-Failure 'element_read_only' 'El control expone ValuePattern, pero está marcado como solo lectura.'
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
