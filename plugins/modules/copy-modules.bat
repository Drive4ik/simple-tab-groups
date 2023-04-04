@echo off

cd /d "%~dp0"

@REM /Y Подавляет запрос на подтверждение перезаписи
@REM /U Копирует только файлы, уже имеющиеся в конечной папке.

xcopy *.js ..\stg-plugin-create-new-group /Y
xcopy *.js ..\stg-plugin-create-new-tab /Y
xcopy *.js ..\stg-plugin-create-temp-tab /Y
xcopy *.js ..\stg-plugin-del-current-group /Y

xcopy *.js ..\stg-plugin-load-custom-group /Y
xcopy *.js ..\stg-plugin-manage-groups /Y

@REM exit /b 0
