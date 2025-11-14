{{/*
Generate chart name + release name prefix
*/}}
{{- define "example-voting-app.fullname" -}}
{{- printf "%s-%s" .Release.Name "voting-app" | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{/*
Common labels
*/}}
{{- define "example-voting-app.labels" -}}
app: {{ include "example-voting-app.name" . }}
release: {{ .Release.Name }}
managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Chart name only
*/}}
{{- define "example-voting-app.name" -}}
example-voting-app
{{- end }}
