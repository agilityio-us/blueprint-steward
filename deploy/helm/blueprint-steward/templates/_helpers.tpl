{{- define "blueprint-steward.fullname" -}}
{{- if contains "blueprint-steward" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-blueprint-steward" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "blueprint-steward.selectorLabels" -}}
app.kubernetes.io/name: blueprint-steward
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "blueprint-steward.labels" -}}
{{ include "blueprint-steward.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
