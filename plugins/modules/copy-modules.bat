@echo off

cd /d "%~dp0"

@REM /Y Подавляет запрос на подтверждение перезаписи
@REM /U Копирует только файлы, уже имеющиеся в конечной папке.

xcopy *.js ..\stg-plugin-create-new-group /U/Y
xcopy *.js ..\stg-plugin-create-new-tab /U/Y
xcopy *.js ..\stg-plugin-create-temp-tab /U/Y
xcopy *.js ..\stg-plugin-del-current-group /U/Y
xcopy *.js ..\stg-plugin-group-notes /U/Y
xcopy *.js ..\stg-plugin-load-custom-group /U/Y
xcopy *.js ..\stg-plugin-manage-groups /U/Y

@REM exit /b 0
