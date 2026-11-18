#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>

// SimulatorKit é carregado do Xcode selecionado, sem vincular frameworks privados no app.
// As assinaturas abaixo foram verificadas no runtime do Xcode. Se mudarem, falhamos com erro.
@interface NSObject (OvseerSimulatorAPI)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (NSUUID *)UDID;
- (id)io;
- (NSArray *)ioPorts;
- (NSString *)portIdentifier;
- (id)descriptor;
- (id)screenProperties;
- (NSString *)uniqueId;
- (id)maskedFramebufferSurface;
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

typedef void *(*MouseMessage)(CGPoint *, CGPoint *, unsigned, NSUInteger, CGSize, unsigned);
typedef void *(*KeyMessage)(NSEvent *);

static void emit(NSDictionary *message) {
    @synchronized (NSFileHandle.fileHandleWithStandardOutput) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
        if (!data) return;
        NSMutableData *line = [data mutableCopy];
        [line appendBytes:"\n" length:1];
        [NSFileHandle.fileHandleWithStandardOutput writeData:line];
    }
}
static void fail(NSString *message) { emit(@{@"type": @"error", @"message": message}); }
static id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}
static CGRect frameOf(AXUIElementRef element) {
    id pos = attribute(element, kAXPositionAttribute), size = attribute(element, kAXSizeAttribute);
    CGPoint p; CGSize s;
    if (!pos || !size || CFGetTypeID((__bridge CFTypeRef)pos) != AXValueGetTypeID() || CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID()) return CGRectZero;
    if (!AXValueGetValue((__bridge AXValueRef)pos, kAXValueCGPointType, &p) || !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &s)) return CGRectZero;
    return (CGRect){p,s};
}

@interface Simulator : NSObject <SCStreamOutput, SCStreamDelegate>
@property SCStream *stream;
@property CIContext *context;
@property id hid;
@property id display;
@property MouseMessage mouseMessage;
@property KeyMessage keyMessage;
@property dispatch_queue_t inputQueue;
@property CGPoint lastTouch;
@property BOOL touching;
@property id homeButton;
@property CGRect screenRect;
@property CGRect windowRect;
@property CGRect captureRect;
@end

@implementation Simulator
- (CIImage *)imageWithNativeScreen:(CIImage *)windowImage {
    if (!self.display) return windowImage;
    @try {
        id surface = [self.display maskedFramebufferSurface];
        if (!surface) return windowImage;
        CIImage *screen = [CIImage imageWithIOSurface:(__bridge IOSurfaceRef)surface];
        if (!screen || CGRectIsEmpty(screen.extent)) return windowImage;
        CGFloat nativeAspect = screen.extent.size.width / screen.extent.size.height;
        CGFloat viewAspect = self.screenRect.size.width / self.screenRect.size.height;
        // Se a orientação/geometria mudou, preserve a captura da janela em vez de deformar a tela.
        if (fabs(nativeAspect / viewAspect - 1) > 0.02) return windowImage;
        CGFloat px = windowImage.extent.size.width / self.captureRect.size.width;
        CGFloat py = windowImage.extent.size.height / self.captureRect.size.height;
        if (screen.extent.size.width <= self.screenRect.size.width * px && screen.extent.size.height <= self.screenRect.size.height * py) return windowImage;
        CGFloat scale = MAX(1, MAX(screen.extent.size.width / (self.screenRect.size.width * px), screen.extent.size.height / (self.screenRect.size.height * py)));
        CIImage *body = [windowImage imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
        CGFloat targetWidth = self.screenRect.size.width * px * scale;
        CGFloat targetHeight = self.screenRect.size.height * py * scale;
        // Preserve os pixels originais da tela: apenas translação em pixels inteiros, sem reamostragem.
        CGFloat x = round((self.screenRect.origin.x - self.captureRect.origin.x) * px * scale + (targetWidth - screen.extent.size.width) / 2);
        CGFloat y = round((CGRectGetMaxY(self.captureRect) - CGRectGetMaxY(self.screenRect)) * py * scale + (targetHeight - screen.extent.size.height) / 2);
        screen = [screen imageByApplyingTransform:CGAffineTransformMakeTranslation(x - screen.extent.origin.x, y - screen.extent.origin.y)];
        return [[screen imageByCompositingOverImage:body] imageByCroppingToRect:CGRectMake(0, 0, ceil(body.extent.size.width), ceil(body.extent.size.height))];
    } @catch (NSException *exception) {
        // A interface do Xcode é opcional; versões incompatíveis continuam com a captura da janela.
        return windowImage;
    }
}
- (void)sendMessage:(void *)message {
    if (!message) return;
    [self.hid sendWithMessage:message freeWhenDone:YES completionQueue:self.inputQueue completion:^(NSError *error) {
        if (error) fail([NSString stringWithFormat:@"O Xcode recusou a entrada: %@. Reconecte o aparelho.", error.localizedDescription]);
    }];
}
- (void)touch:(NSDictionary *)event {
    NSString *phase = event[@"phase"];
    double x = [event[@"x"] doubleValue], y = [event[@"y"] doubleValue];
    if (!isfinite(x) || !isfinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
    if ([phase isEqual:@"down"] && self.touching) return;
    if (![phase isEqual:@"down"] && !self.touching) return;
    NSUInteger type;
    if ([phase isEqual:@"down"]) { type = NSEventTypeLeftMouseDown; self.touching = YES; }
    else if ([phase isEqual:@"move"]) type = NSEventTypeLeftMouseDragged;
    else if ([phase isEqual:@"up"]) { type = NSEventTypeLeftMouseUp; self.touching = NO; }
    else return;
    CGPoint point = CGPointMake(x,y);
    self.lastTouch = point;
    // 0x32 é o destino da tela principal do protocolo Indigo; coordenadas normalizadas.
    [self sendMessage:self.mouseMessage(&point, NULL, 0x32, type, CGSizeMake(1,1), 0)];
}
- (void)key:(NSDictionary *)event {
    NSNumber *code = event[@"code"];
    if (![code isKindOfClass:NSNumber.class] || code.intValue < 0 || code.intValue > 127) return;
    BOOL shift = [event[@"shift"] boolValue];
    NSArray *sequence = shift ? @[@[@56,@YES], @[code,@YES], @[code,@NO], @[@56,@NO]] : @[@[code,@YES], @[code,@NO]];
    for (NSArray *step in sequence) {
        NSEvent *e = [NSEvent keyEventWithType:[step[1] boolValue] ? NSEventTypeKeyDown : NSEventTypeKeyUp location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:[step[0] unsignedShortValue]];
        [self sendMessage:self.keyMessage(e)];
    }
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    @autoreleasepool {
        CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
        if (!buffer) return;
        CIImage *image = [self imageWithNativeScreen:[CIImage imageWithCVPixelBuffer:buffer]];
        CGImageRef cg = [self.context createCGImage:image fromRect:image.extent];
        if (!cg) return;
        NSMutableData *data = [NSMutableData data];
        CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.png"), 1, NULL);
        if (dest) {
            CGImageDestinationAddImage(dest, cg, NULL);
            if (CGImageDestinationFinalize(dest)) emit(@{@"type": @"frame", @"image": [@"data:image/png;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]], @"width": @(CGImageGetWidth(cg)), @"height": @(CGImageGetHeight(cg)), @"touchArea": @{
                @"x": @((self.screenRect.origin.x - self.captureRect.origin.x) / self.captureRect.size.width),
                @"y": @((self.screenRect.origin.y - self.captureRect.origin.y) / self.captureRect.size.height),
                @"width": @(self.screenRect.size.width / self.captureRect.size.width),
                @"height": @(self.screenRect.size.height / self.captureRect.size.height)
            }});
            CFRelease(dest);
        }
        CGImageRelease(cg);
    }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error { fail(error.localizedDescription); exit(1); }
@end

int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 5) return 1;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSString *developer = @(argv[1]), *udid = @(argv[2]), *name = @(argv[3]), *runtime = @(argv[4]);
    if (!CGPreflightScreenCaptureAccess()) {
        CGRequestScreenCaptureAccess();
        fail(@"Permita Gravação da Tela para o Ovseer em Ajustes do Sistema > Privacidade e Segurança e reconecte o aparelho."); return 1;
    }
    if (!AXIsProcessTrusted()) {
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
        fail(@"Permita Acessibilidade para o Ovseer em Ajustes do Sistema > Privacidade e Segurança e reconecte o aparelho."); return 1;
    }
    dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
    void *kit = dlopen([[developer stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] fileSystemRepresentation], RTLD_NOW);
    Class contextClass = NSClassFromString(@"SimServiceContext"), hidClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    SEL contextSelector = @selector(sharedServiceContextForDeveloperDir:error:), initSelector = @selector(initWithDevice:error:);
    if (!kit || ![contextClass respondsToSelector:contextSelector] || ![hidClass instancesRespondToSelector:initSelector] || ![hidClass instancesRespondToSelector:@selector(sendWithMessage:freeWhenDone:completionQueue:completion:)]) {
        fail(@"Esta versão do Xcode não oferece a interface de entrada compatível com o Ovseer."); return 1;
    }
    Simulator *sim = [Simulator new];
    sim.mouseMessage = (MouseMessage)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
    sim.keyMessage = (KeyMessage)dlsym(kit, "IndigoHIDMessageForKeyboardNSEvent");
    if (!sim.mouseMessage || !sim.keyMessage) { fail(@"Interface de entrada do Xcode indisponível."); return 1; }
    NSError *error = nil;
    id context = [contextClass sharedServiceContextForDeveloperDir:developer error:&error];
    id set = [context defaultDeviceSetWithError:&error];
    id device = nil;
    for (id d in [set availableDevices]) if ([[[d UDID] UUIDString] caseInsensitiveCompare:udid] == NSOrderedSame) device = d;
    if (!device) { fail(@"O aparelho selecionado não está disponível no Xcode ativo."); return 1; }
    @try {
        for (id port in [[device io] ioPorts]) {
            if (![[port portIdentifier] isEqual:@"com.apple.framebuffer.display"]) continue;
            id display = [port descriptor];
            if ([display respondsToSelector:@selector(screenProperties)] && [display respondsToSelector:@selector(maskedFramebufferSurface)] && [[[display screenProperties] uniqueId] isEqual:@"PurpleMain"]) {
                sim.display = display;
                break;
            }
        }
    } @catch (NSException *exception) { /* captura da janela como alternativa */ }
    sim.hid = [[hidClass alloc] initWithDevice:device error:&error];
    if (!sim.hid) { fail(error.localizedDescription ?: @"Não foi possível conectar a entrada do simulador."); return 1; }
    sim.inputQueue = dispatch_queue_create("ovseer.simulator.input", DISPATCH_QUEUE_SERIAL);
    sim.context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @NO}];
    NSArray *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.iphonesimulator"];
    if (apps.count != 1) { fail(@"Abra o Simulator do Xcode selecionado e reconecte."); return 1; }
    NSRunningApplication *running = apps.firstObject;
    [running unhide]; // janelas de apps ocultos só produzem quadros vazios no ScreenCaptureKit
    AXUIElementRef app = AXUIElementCreateApplication(running.processIdentifier);
    NSArray *windows = attribute(app, kAXWindowsAttribute);
    NSString *title = [NSString stringWithFormat:@"%@ – %@", name, runtime];
    NSMutableArray *matching = [NSMutableArray array];
    for (id w in windows) if ([attribute((__bridge AXUIElementRef)w, kAXTitleAttribute) isEqual:title]) [matching addObject:w];
    CFRelease(app);
    if (matching.count != 1) { fail(@"Não foi possível identificar com segurança a janela deste aparelho. Abra o aparelho no Simulator e reconecte."); return 1; }
    AXUIElementRef window = (__bridge AXUIElementRef)matching.firstObject;
    AXUIElementSetAttributeValue(window, kAXMinimizedAttribute, kCFBooleanFalse);
    sim.windowRect = frameOf(window);
    sim.captureRect = sim.windowRect;
    for (id child in attribute(window, kAXChildrenAttribute)) {
        if ([attribute((__bridge AXUIElementRef)child, kAXRoleAttribute) isEqual:@"AXToolbar"]) {
            // A captura inclui o corpo inteiro do aparelho; só a barra da janela fica de fora.
            CGRect toolbar = frameOf((__bridge AXUIElementRef)child);
            if (!CGRectIsEmpty(toolbar) && CGRectContainsRect(sim.windowRect, toolbar)) {
                CGFloat top = CGRectGetMaxY(toolbar);
                sim.captureRect = CGRectMake(sim.windowRect.origin.x, top, sim.windowRect.size.width, CGRectGetMaxY(sim.windowRect) - top);
            }
            for (id button in attribute((__bridge AXUIElementRef)child, kAXChildrenAttribute)) {
                if ([attribute((__bridge AXUIElementRef)button, kAXTitleAttribute) isEqual:@"Home"] || [attribute((__bridge AXUIElementRef)button, kAXDescriptionAttribute) isEqual:@"Home"]) sim.homeButton = button;
            }
        }
        if ([attribute((__bridge AXUIElementRef)child, kAXRoleAttribute) isEqual:@"AXGroup"]) {
            CGRect rect = frameOf((__bridge AXUIElementRef)child);
            if (rect.size.width > 100 && rect.size.height > 100 && CGRectContainsRect(sim.windowRect, rect)) { sim.screenRect = rect; }
        }
    }
    if (CGRectIsEmpty(sim.screenRect)) { fail(@"A tela do aparelho não foi encontrada na janela do Simulator."); return 1; }
    if (CGRectIsEmpty(sim.captureRect) || !CGRectContainsRect(sim.captureRect, sim.screenRect)) { fail(@"A área do aparelho não foi identificada na janela do Simulator."); return 1; }
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *err) {
        if (err) { fail(err.localizedDescription); exit(1); }
        NSMutableArray<SCWindow *> *candidates = [NSMutableArray array];
        for (SCWindow *w in content.windows) {
            if ([w.owningApplication.bundleIdentifier isEqual:@"com.apple.iphonesimulator"] && fabs(w.frame.origin.x - sim.windowRect.origin.x) < 2 && fabs(w.frame.origin.y - sim.windowRect.origin.y) < 2 && fabs(w.frame.size.width - sim.windowRect.size.width) < 2 && fabs(w.frame.size.height - sim.windowRect.size.height) < 2) [candidates addObject:w];
        }
        if (candidates.count != 1) { fail(@"A janela do aparelho não está disponível para captura."); exit(1); }
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:candidates.firstObject];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.sourceRect = CGRectMake(sim.captureRect.origin.x - sim.windowRect.origin.x, sim.captureRect.origin.y - sim.windowRect.origin.y, sim.captureRect.size.width, sim.captureRect.size.height);
        // A geometria do AX usa pontos; preserve os pixels da janela em telas Retina.
        config.width = lround(sim.captureRect.size.width * filter.pointPixelScale);
        config.height = lround(sim.captureRect.size.height * filter.pointPixelScale);
        config.captureResolution = SCCaptureResolutionBest;
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.minimumFrameInterval = CMTimeMake(1, 20);
        config.queueDepth = 3;
        config.scalesToFit = NO;
        config.showsCursor = NO;
        config.shouldBeOpaque = NO;
        config.backgroundColor = CGColorGetConstantColor(kCGColorClear);
        if (@available(macOS 14.0, *)) config.ignoreShadowsSingleWindow = YES;
        sim.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:sim];
        NSError *outputError = nil;
        if (![sim.stream addStreamOutput:sim type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_queue_create("ovseer.simulator.frames", DISPATCH_QUEUE_SERIAL) error:&outputError]) { fail(outputError.localizedDescription); exit(1); }
        [sim.stream startCaptureWithCompletionHandler:^(NSError *startError) {
            if (startError) { fail(startError.localizedDescription); exit(1); }
            emit(@{@"type": @"ready"});
        }];
    }];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        char *line = NULL; size_t capacity = 0;
        while (getline(&line, &capacity, stdin) > 0) { @autoreleasepool {
            NSData *data = [@(line) dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *event = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            if (![event isKindOfClass:NSDictionary.class]) continue;
            dispatch_async(sim.inputQueue, ^{
                if ([event[@"type"] isEqual:@"touch"]) [sim touch:event];
                else if ([event[@"type"] isEqual:@"key"]) [sim key:event];
                else if ([event[@"type"] isEqual:@"home"]) {
                    if (!sim.homeButton || AXUIElementPerformAction((__bridge AXUIElementRef)sim.homeButton, kAXPressAction) != kAXErrorSuccess) fail(@"O botão Início não está disponível neste Simulator.");
                }
            });
        } }
        free(line);
        // Solta qualquer toque pendente antes de desconectar.
        dispatch_sync(sim.inputQueue, ^{ if (sim.touching) [sim touch:@{@"phase": @"up", @"x": @(sim.lastTouch.x), @"y": @(sim.lastTouch.y)}]; });
        [sim.stream stopCaptureWithCompletionHandler:^(NSError *err) { exit(0); }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
    });
    [NSApp run];
    return 0;
} }
