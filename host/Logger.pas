unit Logger;

interface

uses
	System.SysUtils, System.IOUtils, System.JSON, System.Classes, Settings, Winapi.Windows;

procedure Log(const Msg: string; const Level: string = '');

implementation

procedure Log(const Msg: string; const Level: string = '');
var
	FullName: string;
	Line: string;
	Bytes: TBytes;
	FS: TFileStream;
	Mutex: THandle;
begin
	if not IsLoggingEnabled then
		Exit;

	FullName := ExeInfo.FilePath + 'logs.log';

	if Msg = sLineBreak then
		Line := sLineBreak
	else
	begin
		Line := FormatDateTime('yyyy-mm-dd hh:nn:ss.zzz', Now) + ' ';
		if Level <> '' then
			Line := Line + '[' + Level + '] ';
		Line := Line + Msg + sLineBreak;
	end;

	// Create a named mutex for exclusive access to the log file
	Mutex := CreateMutex(nil, False, 'STGHostLogMutex');
	if Mutex = 0 then
		Exit; // Failed to create mutex

	try
		// Wait for exclusive access to the log file
		if WaitForSingleObject(Mutex, 50) <> WAIT_OBJECT_0 then
			Exit; // Timeout or error

		try
			const MaxLogSize: Int64 = 100 * 1024; // 100 KB

			if TFile.Exists(FullName) and (TFile.GetSize(FullName) > MaxLogSize) then
			begin
				Bytes := TFile.ReadAllBytes(FullName);
				var Half := Length(Bytes) div 2;
				Bytes := Copy(Bytes, Half, Length(Bytes) - Half);
				TFile.WriteAllBytes(FullName, Bytes);
			end;

			FS := TFileStream.Create(FullName, fmOpenReadWrite or fmShareDenyWrite);
			try
				FS.Seek(0, soFromEnd);
				Bytes := TEncoding.UTF8.GetBytes(Line);
				FS.WriteBuffer(Bytes, Length(Bytes));
			finally
				FS.Free;
			end;
		finally
			// Release the mutex
			ReleaseMutex(Mutex);
		end;
	finally
		// Close the mutex handle
		CloseHandle(Mutex);
	end;
end;


end.
