#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(SSHPlugin, "SSH",
    CAP_PLUGIN_METHOD(connect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disconnect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(write, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resize, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isConnected, CAPPluginReturnPromise);
)
