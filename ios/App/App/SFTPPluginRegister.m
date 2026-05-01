#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(SFTPPlugin, "SFTP",
    CAP_PLUGIN_METHOD(connect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disconnect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(listDir, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(mkdir, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(deletePath, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(rename, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(realPath, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(readFile, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(writeFile, CAPPluginReturnPromise);
)
