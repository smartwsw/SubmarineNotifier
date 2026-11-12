using System.Net;

namespace SubmarineReturnNotifier.Core.Cloud;

/// <summary>云端调用的统一结果。客户端实现必须保证不抛异常。</summary>
public sealed record CloudResponse<T>(bool Success, T? Data, string? ErrorCode, string? ErrorMessage, int? StatusCode)
{
    public bool Unauthorized => StatusCode is (int)HttpStatusCode.Unauthorized or (int)HttpStatusCode.Forbidden;

    public static CloudResponse<T> Ok(T data, int statusCode = 200) => new(true, data, null, null, statusCode);

    public static CloudResponse<T> Fail(string code, string message, int? statusCode = null)
        => new(false, default, code, message, statusCode);
}

/// <summary>上传链路依赖的最小云端接口（只包含同步）。</summary>
public interface ICloudApi
{
    string BaseUrl { get; }
    string Token { get; }

    Task<CloudResponse<SyncResponseDto>> SyncAsync(SyncRequestDto payload, CancellationToken cancellationToken);
}
